import express from 'express';
import { db } from '../db.js';
import { saasCommerciaux, saasClients, saasVentes, entreprises } from '../schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'comptaorion-commercial-secret-key';

function authenticateCommercial(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'commercial') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    req.commercial = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const [commercial] = await db.select()
      .from(saasCommerciaux)
      .where(eq(saasCommerciaux.email, email.toLowerCase()))
      .limit(1);

    if (!commercial) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    if (!commercial.actif) {
      return res.status(403).json({ error: 'Compte désactivé' });
    }

    if (!commercial.passwordHash) {
      return res.status(400).json({ error: 'Mot de passe non configuré. Contactez l\'administrateur.' });
    }

    const isValidPassword = await bcrypt.compare(password, commercial.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = jwt.sign(
      { 
        id: commercial.id, 
        email: commercial.email,
        nom: commercial.nom,
        prenom: commercial.prenom,
        type: 'commercial'
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      commercial: {
        id: commercial.id,
        nom: commercial.nom,
        prenom: commercial.prenom,
        email: commercial.email,
        region: commercial.region,
        commission: commercial.commission
      }
    });
  } catch (error) {
    console.error('Erreur login commercial:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', authenticateCommercial, async (req, res) => {
  try {
    const [commercial] = await db.select({
      id: saasCommerciaux.id,
      nom: saasCommerciaux.nom,
      prenom: saasCommerciaux.prenom,
      email: saasCommerciaux.email,
      telephone: saasCommerciaux.telephone,
      region: saasCommerciaux.region,
      commission: saasCommerciaux.commission,
      objectifMensuel: saasCommerciaux.objectifMensuel
    })
    .from(saasCommerciaux)
    .where(eq(saasCommerciaux.id, req.commercial.id))
    .limit(1);

    if (!commercial) {
      return res.status(404).json({ error: 'Commercial non trouvé' });
    }

    res.json(commercial);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', authenticateCommercial, async (req, res) => {
  try {
    const commercialId = req.commercial.id;

    const clients = await db.select({
      id: saasClients.id,
      entrepriseNom: entreprises.nom,
      statut: saasClients.statut,
      dateInscription: saasClients.dateInscription,
      source: saasClients.source
    })
    .from(saasClients)
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .where(eq(saasClients.commercialId, commercialId))
    .orderBy(desc(saasClients.dateInscription));

    const ventes = await db.select({
      id: saasVentes.id,
      clientNom: entreprises.nom,
      montantVente: saasVentes.montantVente,
      commission: saasVentes.commission,
      dateVente: saasVentes.dateVente,
      statut: saasVentes.statut
    })
    .from(saasVentes)
    .leftJoin(saasClients, eq(saasVentes.clientId, saasClients.id))
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .where(eq(saasVentes.commercialId, commercialId))
    .orderBy(desc(saasVentes.dateVente));

    const statsResult = await db.execute(sql`
      SELECT 
        COUNT(DISTINCT sc.id) as total_clients,
        COUNT(DISTINCT CASE WHEN sc.statut = 'actif' THEN sc.id END) as clients_actifs,
        COALESCE(SUM(sv.montant_vente), 0) as ca_total,
        COALESCE(SUM(sv.commission), 0) as commissions_totales,
        COALESCE(SUM(CASE WHEN sv.date_vente >= date_trunc('month', CURRENT_DATE) THEN sv.montant_vente ELSE 0 END), 0) as ca_mois,
        COALESCE(SUM(CASE WHEN sv.date_vente >= date_trunc('month', CURRENT_DATE) THEN sv.commission ELSE 0 END), 0) as commissions_mois
      FROM saas_commerciaux c
      LEFT JOIN saas_clients sc ON sc.commercial_id = c.id
      LEFT JOIN saas_ventes sv ON sv.commercial_id = c.id AND sv.statut = 'confirmée'
      WHERE c.id = ${commercialId}
    `);
    const stats = statsResult.rows?.[0] || statsResult[0] || {};

    res.json({
      stats: stats || {},
      clients,
      ventes,
      lienParrainage: `/inscription?ref=${commercialId}`
    });
  } catch (error) {
    console.error('Erreur dashboard commercial:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
