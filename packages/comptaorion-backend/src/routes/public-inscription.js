import express from 'express';
import { db } from '../db.js';
import { entreprises, users, plansAbonnement, abonnements, saasClients, saasVentes, saasCommerciaux, inscriptionsEnAttente } from '../schema.js';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { createRequire } from 'module';
import crypto from 'crypto';
import emailService from '../services/emailService.js';
import { createVerificationCode } from '../services/emailVerification.js';
import { calculerOffreAbonnement, commissionSur, montantPayant } from '../saas-offre.js';
import { tauxTvaParPays } from '../utils/tva.js';

const require = createRequire(import.meta.url);
const fedapayModule = require('fedapay');
const FedaPay = fedapayModule.FedaPay;
const Transaction = fedapayModule.Transaction;

const router = express.Router();

// Configuration FedaPay
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_PUBLIC_KEY = process.env.FEDAPAY_PUBLIC_KEY;
const FEDAPAY_ENVIRONMENT = process.env.FEDAPAY_ENVIRONMENT || 'sandbox'; // sandbox ou live

if (FEDAPAY_SECRET_KEY) {
  FedaPay.setApiKey(FEDAPAY_SECRET_KEY);
  FedaPay.setEnvironment(FEDAPAY_ENVIRONMENT);
  console.log(`✅ FedaPay configuré en mode ${FEDAPAY_ENVIRONMENT}`);
}

// ===========================================
// FONCTION UTILITAIRE - EMAIL DE BIENVENUE
// ===========================================

/**
 * Envoie l'e-mail de vérification à un client créé via FedaPay (28 nov.
 * 2026) : le compte est créé mais ne peut pas se connecter tant que
 * l'e-mail n'est pas vérifié. Le mot de passe temporaire généré n'est
 * JAMAIS envoyé en clair : l'e-mail contient uniquement le code à
 * 6 chiffres, et le client définit ensuite son mot de passe via
 * « Mot de passe oublié ». Si l'envoi échoue (MAKE_WEBHOOK_URL absente),
 * l'inscription reste créée : le code est en base et reste renvoyable
 * depuis la page de vérification — on journalise, on ne bloque pas.
 */
async function envoyerEmailBienvenue(email, nomEntreprise, entrepriseId, user) {
  const { code } = await createVerificationCode(db, { userId: user.id, email });
  const result = await emailService.sendVerificationCodeEmail({
    to: email,
    code,
    nomEntreprise,
    entrepriseId,
    userId: user.id,
    isFedapay: true,
  });
  if (!result.success) {
    console.error('❌ Code de vérification non envoyé à', email, ':', result.error || result.message);
    console.error(`⚠️ Le client (ID ${entrepriseId}) n'a PAS reçu son code de vérification : il pourra en demander un nouveau depuis la page de vérification.`);
    return;
  }
  console.log('✅ E-mail de vérification envoyé à', email);
}

// ===========================================
// ROUTES PUBLIQUES (sans authentification)
// ===========================================

// GET /api/public/commercial/:id - Récupérer les infos d'un commercial (pour lien parrainage)
router.get('/commercial/:id', async (req, res) => {
  try {
    const commercialId = parseInt(req.params.id);
    if (!commercialId || isNaN(commercialId)) {
      return res.status(400).json({ error: 'ID commercial invalide' });
    }

    const [commercial] = await db.select({
      id: saasCommerciaux.id,
      nom: saasCommerciaux.nom,
      prenom: saasCommerciaux.prenom,
      region: saasCommerciaux.region
    })
    .from(saasCommerciaux)
    .where(eq(saasCommerciaux.id, commercialId))
    .limit(1);

    if (!commercial || !commercial.id) {
      return res.status(404).json({ error: 'Commercial non trouvé' });
    }

    res.json(commercial);
  } catch (error) {
    console.error('Erreur récupération commercial:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/public/plans - Récupérer les plans tarifaires publics
router.get('/plans', async (req, res) => {
  try {
    const plans = await db.select({
      id: plansAbonnement.id,
      nom: plansAbonnement.nom,
      prix: plansAbonnement.prix,
      devise: plansAbonnement.devise,
      periode: plansAbonnement.periode,
      limiteUtilisateurs: plansAbonnement.limiteUtilisateurs,
      limiteEntreprises: plansAbonnement.limiteEntreprises,
      stockageGb: plansAbonnement.stockageGb,
      descriptionFeatures: plansAbonnement.descriptionFeatures
    })
    .from(plansAbonnement)
    .where(eq(plansAbonnement.actif, true))
    .orderBy(plansAbonnement.prix);

    res.json(plans);
  } catch (error) {
    console.error('Erreur récupération plans:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/public/inscription - Inscription publique
router.post('/inscription', async (req, res) => {
  try {
    const { 
      nomEntreprise, 
      email, 
      telephone, 
      pays,
      planId,
      dureeEnMois,
      methodePaiement, // fedapay, stripe, paypal
      commercialId // ID du commercial référent (lien parrainage)
    } = req.body;

    // Validation
    if (!nomEntreprise || !email || !planId || !dureeEnMois) {
      return res.status(400).json({ 
        error: 'Informations manquantes. Veuillez remplir tous les champs requis.' 
      });
    }

    // Vérifier si l'utilisateur existe déjà pour déterminer le type d'inscription
    const existingUser = await db.select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    
    const typeInscription = existingUser.length > 0 ? 'renouvellement' : 'nouveau';
    const entrepriseIdPourRenouvellement = existingUser.length > 0 ? existingUser[0].entrepriseId : null;

    // Récupérer le plan
    const [plan] = await db.select()
      .from(plansAbonnement)
      .where(eq(plansAbonnement.id, parseInt(planId)))
      .limit(1);

    if (!plan) {
      return res.status(404).json({ error: 'Plan non trouvé' });
    }

    // Calculer le montant total : offre « 2 mois gratuits » — le client
    // paie prix × (durée − 2) ; la facturation commence au 3e mois.
    const dureeMois = parseInt(dureeEnMois, 10);
    if (!Number.isSafeInteger(dureeMois) || dureeMois < 1) {
      return res.status(400).json({
        error: 'La durée de l’abonnement doit être d’au moins 1 mois.'
      });
    }
    const montantTotal = montantPayant(plan.prix, dureeMois);

    // Créer une transaction en attente
    const inscriptionData = {
      nomEntreprise,
      email: email.toLowerCase(),
      telephone,
      pays,
      planId: parseInt(planId),
      dureeEnMois: parseInt(dureeEnMois),
      montantTotal,
      methodePaiement,
      statut: 'en_attente_paiement'
    };

    // Créer la transaction de paiement selon la méthode choisie
    let paymentUrl = null;
    let transactionId = null;

    if (methodePaiement === 'fedapay') {
      // Créer transaction FedaPay
      if (!FEDAPAY_SECRET_KEY) {
        return res.status(500).json({ 
          error: 'FedaPay n\'est pas configuré. Veuillez contacter l\'administrateur.' 
        });
      }

      try {
        const transaction = await Transaction.create({
          description: `ComptaOrion - ${plan.nom} (${dureeEnMois} mois)`,
          amount: montantTotal,
          currency: { iso: plan.devise || 'XOF' },
          callback_url: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/public/webhook/fedapay`,
          customer: {
            firstname: nomEntreprise.split(' ')[0] || 'Client',
            lastname: nomEntreprise.split(' ').slice(1).join(' ') || 'ComptaOrion',
            email: email,
            phone_number: telephone ? {
              number: telephone,
              country: (pays || 'bj').toLowerCase().substring(0, 2)
            } : undefined
          },
          custom_metadata: inscriptionData
        });

        const token = await transaction.generateToken();
        paymentUrl = token.url;
        transactionId = transaction.id;
        
        // Persister l'inscription en attente avec le transaction_id
        await db.insert(inscriptionsEnAttente).values({
          transactionId: transaction.id,
          email: email.toLowerCase(),
          nomEntreprise,
          telephone,
          pays,
          planId: parseInt(planId),
          dureeEnMois: parseInt(dureeEnMois),
          montantTotal,
          methodePaiement,
          typeInscription,
          commercialId: commercialId ? parseInt(commercialId) : null,
          entrepriseIdPourRenouvellement
        });

      } catch (fedapayError) {
        console.error('Erreur FedaPay:', fedapayError);
        return res.status(500).json({ 
          error: 'Erreur lors de la création de la transaction FedaPay: ' + fedapayError.message 
        });
      }
    } else if (methodePaiement === 'stripe') {
      // TODO: Implémenter Stripe
      return res.status(501).json({ error: 'Stripe sera bientôt disponible' });
    } else if (methodePaiement === 'paypal') {
      // TODO: Implémenter PayPal
      return res.status(501).json({ error: 'PayPal sera bientôt disponible' });
    } else {
      return res.status(400).json({ error: 'Méthode de paiement non supportée' });
    }

    res.json({
      success: true,
      message: 'Inscription initiée. Veuillez procéder au paiement.',
      paymentUrl,
      transactionId,
      montantTotal,
      devise: plan.devise || 'XOF'
    });

  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fonction de vérification de signature HMAC FedaPay
function verifyFedaPaySignature(signatureHeader, payload, secret) {
  if (!signatureHeader) {
    return false;
  }

  try {
    // Parse signature header: t=timestamp,v1=signature
    const sigParts = {};
    signatureHeader.split(',').forEach(item => {
      const [key, value] = item.split('=');
      sigParts[key] = value;
    });

    const timestamp = sigParts.t;
    const signature = sigParts.v1;

    if (!timestamp || !signature) {
      return false;
    }

    // Vérifier timestamp (prévenir les attaques par rejeu - tolérance 5 minutes)
    const TOLERANCE = 300; // 5 minutes
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > TOLERANCE) {
      console.log('⚠️ Timestamp trop ancien - possible attaque par rejeu');
      return false;
    }

    // Calculer la signature attendue
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    // Comparaison sécurisée contre les attaques temporelles
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error('Erreur vérification signature:', error);
    return false;
  }
}

// POST /api/public/webhook/fedapay - Webhook FedaPay
router.post('/webhook/fedapay', async (req, res) => {
  try {
    const { transaction_id, status } = req.body;

    console.log('Webhook FedaPay reçu:', { transaction_id, status });

    // SÉCURITÉ : Vérifier que la requête vient bien de FedaPay
    if (!FEDAPAY_SECRET_KEY) {
      console.error('FedaPay non configuré - webhook rejeté');
      return res.status(500).json({ error: 'FedaPay non configuré' });
    }

    // Vérifier la signature HMAC du webhook (protection contre falsification)
    const signatureHeader = req.headers['x-fedapay-signature'];
    
    // Vérification stricte : req.rawBody DOIT être défini
    if (!req.rawBody) {
      console.error('❌ rawBody manquant - webhook rejeté (middleware non configuré correctement)');
      return res.status(500).json({ error: 'Configuration serveur invalide' });
    }
    
    if (!verifyFedaPaySignature(signatureHeader, req.rawBody, FEDAPAY_SECRET_KEY)) {
      console.error('❌ Signature FedaPay invalide - webhook rejeté');
      return res.status(403).json({ error: 'Signature invalide' });
    }

    console.log('✅ Signature FedaPay vérifiée');

    // Récupérer la transaction depuis FedaPay pour double vérification
    let transaction;
    try {
      transaction = await FedaPay.Transaction.retrieve(transaction_id);
    } catch (fedapayError) {
      console.error('Transaction FedaPay invalide:', fedapayError);
      return res.status(400).json({ error: 'Transaction invalide' });
    }

    // Vérifier que le statut correspond bien
    if (transaction.status !== status) {
      console.error('Statut webhook ne correspond pas à FedaPay');
      return res.status(400).json({ error: 'Statut incohérent' });
    }

    if (status === 'approved') {
      // Récupérer l'inscription en attente depuis la table
      const [inscriptionEnAttente] = await db.select()
        .from(inscriptionsEnAttente)
        .where(eq(inscriptionsEnAttente.transactionId, transaction_id))
        .limit(1);

      if (!inscriptionEnAttente) {
        console.error('Inscription en attente non trouvée pour transaction:', transaction_id);
        return res.status(400).json({ error: 'Inscription non trouvée' });
      }

      // Vérifier si c'est un doublon (déjà traité)
      if (inscriptionEnAttente.traitee) {
        console.log(`Transaction ${transaction_id} déjà traitée - webhook ignoré (idempotence)`);
        return res.json({ success: true, message: 'Transaction déjà traitée' });
      }

      // Utiliser typeInscription de la table au lieu de deviner
      const typeInscription = inscriptionEnAttente.typeInscription;

      if (typeInscription === 'renouvellement') {
        // C'est un renouvellement
        console.log('Traitement renouvellement en cours');
        
        // Vérifier que l'entrepriseId est présent
        if (!inscriptionEnAttente.entrepriseIdPourRenouvellement) {
          console.error('Entreprise ID manquant pour renouvellement - webhook rejeté');
          return res.status(400).json({ error: 'Entreprise invalide' });
        }
        
        // Récupérer l'entreprise
        const entreprise = await db.select()
          .from(entreprises)
          .where(eq(entreprises.id, inscriptionEnAttente.entrepriseIdPourRenouvellement))
          .limit(1);
        
        if (entreprise.length === 0) {
          console.error('Entreprise non trouvée - webhook rejeté');
          return res.status(400).json({ error: 'Entreprise introuvable' });
        }

        const clientSaas = await db.select()
          .from(saasClients)
          .where(eq(saasClients.entrepriseId, entreprise[0].id))
          .limit(1);

        // Créer nouvel abonnement (renouvellement) — offre « 2 mois
        // gratuits » : le montant total payé couvre les mois payants
        // (durée − 2) ; le montant mensuel reste le prix du plan (il
        // sert au MRR une fois la facturation commencée).
        const [planRenouvellement] = await db.select()
          .from(plansAbonnement)
          .where(eq(plansAbonnement.id, inscriptionEnAttente.planId))
          .limit(1);
        if (!planRenouvellement) {
          console.error('Plan introuvable pour le renouvellement:', inscriptionEnAttente.planId);
          return res.status(400).json({ error: 'Plan introuvable' });
        }
        const dateDebut = new Date();
        const offreRenouvellement = calculerOffreAbonnement({
          prixMensuel: planRenouvellement.prix,
          dureeEnMois: inscriptionEnAttente.dureeEnMois,
          dateDebut,
        });

        const [abonnement] = await db.insert(abonnements).values({
          entrepriseId: entreprise[0].id,
          planId: inscriptionEnAttente.planId,
          statut: 'actif',
          dateDebut,
          dateExpiration: new Date(offreRenouvellement.dateExpiration),
          prochainRenouvellement: new Date(offreRenouvellement.dateExpiration),
          montantMensuel: planRenouvellement.prix,
          moisGratuits: offreRenouvellement.moisGratuits,
          dateDebutFacturation: new Date(offreRenouvellement.dateDebutFacturation),
        }).returning();

        // Créer la vente de renouvellement
        await db.insert(saasVentes).values({
          commercialId: null,
          clientId: clientSaas[0].id,
          abonnementId: abonnement.id,
          montantVente: inscriptionEnAttente.montantTotal.toString(),
          commission: 0,
          statut: 'confirmée',
          source: 'web',
          notes: `Renouvellement web - FedaPay ${transaction_id} (2 mois gratuits, facturation dès le ${offreRenouvellement.dateDebutFacturation})`,
          dateEcheanceCommission: new Date(offreRenouvellement.dateDebutFacturation),
        });
        
        // Marquer comme traitée
        await db.update(inscriptionsEnAttente)
          .set({ traitee: true })
          .where(eq(inscriptionsEnAttente.id, inscriptionEnAttente.id));

        console.log('✅ Renouvellement complété');
        return res.json({ success: true, message: 'Renouvellement complété avec succès' });
      }

      // Nouveau client - Créer l'entreprise. Le taux de TVA est déduit du
      // pays déclaré (ce flux ne propose pas encore le choix 0 % / 18 % /
      // personnalisé du formulaire d'inscription libre-service) ; défaut 18 %.
      const paysEntreprise = inscriptionEnAttente.pays || 'Bénin';
      const [newEntreprise] = await db.insert(entreprises).values({
        nom: inscriptionEnAttente.nomEntreprise,
        email: inscriptionEnAttente.email,
        telephone: inscriptionEnAttente.telephone,
        pays: paysEntreprise,
        tauxTva: tauxTvaParPays(paysEntreprise).toFixed(2),
        devise: 'XOF',
        systemeComptable: 'SYSCOHADA'
      }).returning();

      // Générer un mot de passe temporaire
      const motDePasseTemporaire = Math.random().toString(36).slice(-10);
      const hashedPassword = await bcrypt.hash(motDePasseTemporaire, 10);

      // Générer un username unique à partir de l'email
      const username = inscriptionEnAttente.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36);

      // Créer l'utilisateur admin
      const [newUser] = await db.insert(users).values({
        nom: inscriptionEnAttente.nomEntreprise,
        email: inscriptionEnAttente.email,
        username: username,
        passwordHash: hashedPassword,
        entrepriseId: newEntreprise.id,
        role: 'admin',
        actif: true
      }).returning();

      // Récupérer le commercial si un lien parrainage a été utilisé
      let commercialData = null;
      if (inscriptionEnAttente.commercialId) {
        const [commercial] = await db.select()
          .from(saasCommerciaux)
          .where(eq(saasCommerciaux.id, inscriptionEnAttente.commercialId))
          .limit(1);
        if (commercial) {
          commercialData = commercial;
          console.log(`📣 Inscription via parrainage commercial: ${commercial.nom} ${commercial.prenom}`);
        }
      }

      // Créer le client SaaS
      const [clientSaas] = await db.insert(saasClients).values({
        entrepriseId: newEntreprise.id,
        commercialId: commercialData ? commercialData.id : null,
        statut: 'actif',
        source: commercialData ? 'commercial' : 'web',
        notes: commercialData 
          ? `Inscription via lien parrainage ${commercialData.nom} ${commercialData.prenom} - FedaPay ${transaction_id}`
          : `Inscription web - Paiement FedaPay ${transaction_id}`
      }).returning();

      // Créer l'abonnement — offre « 2 mois gratuits » : le montant
      // total payé couvre les mois payants (durée − 2) ; le montant
      // mensuel reste le prix du plan (il sert au MRR une fois la
      // facturation commencée).
      const [planNouveau] = await db.select()
        .from(plansAbonnement)
        .where(eq(plansAbonnement.id, inscriptionEnAttente.planId))
        .limit(1);
      if (!planNouveau) {
        console.error('Plan introuvable pour la nouvelle inscription:', inscriptionEnAttente.planId);
        return res.status(400).json({ error: 'Plan introuvable' });
      }
      const dateDebut = new Date();
      const offreNouveau = calculerOffreAbonnement({
        prixMensuel: planNouveau.prix,
        dureeEnMois: inscriptionEnAttente.dureeEnMois,
        dateDebut,
      });

      const [abonnement] = await db.insert(abonnements).values({
        entrepriseId: newEntreprise.id,
        planId: inscriptionEnAttente.planId,
        statut: 'actif',
        dateDebut,
        dateExpiration: new Date(offreNouveau.dateExpiration),
        prochainRenouvellement: new Date(offreNouveau.dateExpiration),
        montantMensuel: planNouveau.prix,
        moisGratuits: offreNouveau.moisGratuits,
        dateDebutFacturation: new Date(offreNouveau.dateDebutFacturation),
      }).returning();

      // Calculer la commission si parrainage (10 % du montant payé ;
      // due seulement à partir du début de facturation).
      const commissionAmount = commercialData
        ? commissionSur(inscriptionEnAttente.montantTotal, 0.10)
        : 0;

      // Créer la vente
      await db.insert(saasVentes).values({
        commercialId: commercialData ? commercialData.id : null,
        clientId: clientSaas.id,
        abonnementId: abonnement.id,
        montantVente: inscriptionEnAttente.montantTotal.toString(),
        commission: commissionAmount,
        statut: 'confirmée',
        source: commercialData ? 'commercial' : 'web',
        notes: commercialData 
          ? `Vente via lien parrainage ${commercialData.nom} ${commercialData.prenom} - FedaPay ${transaction_id} (2 mois gratuits, facturation dès le ${offreNouveau.dateDebutFacturation})`
          : `Inscription web - FedaPay ${transaction_id} (2 mois gratuits, facturation dès le ${offreNouveau.dateDebutFacturation})`,
        dateEcheanceCommission: new Date(offreNouveau.dateDebutFacturation),
      });
      
      // Marquer comme traitée
      await db.update(inscriptionsEnAttente)
        .set({ traitee: true })
        .where(eq(inscriptionsEnAttente.id, inscriptionEnAttente.id));

      console.log('✅ Inscription complétée');

      // Envoyer l'e-mail de vérification (code à 6 chiffres, jamais le mot
      // de passe en clair). Le client vérifie son adresse, puis définit
      // son mot de passe via « Mot de passe oublié ».
      try {
        await envoyerEmailBienvenue(
          inscriptionEnAttente.email,
          inscriptionEnAttente.nomEntreprise,
          newEntreprise.id,
          newUser
        );
      } catch (emailError) {
        console.error('❌ ERREUR: Impossible d\'envoyer l\'email de vérification:', emailError.message);
        console.error(`⚠️ Le client (ID ${newEntreprise.id}) pourra demander un nouveau code depuis la page de vérification.`);
      }

      res.json({ success: true, message: 'Inscription complétée avec succès' });
    } else {
      console.log(`⚠️ Paiement non approuvé: ${status}`);
      res.json({ success: false, message: 'Paiement non approuvé' });
    }

  } catch (error) {
    console.error('Erreur webhook FedaPay:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
