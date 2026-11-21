import { db } from '../db.js';
import { journaux, ecritures, lignesEcritures, comptesComptables, parametresComptables } from '../schema.js';
import { eq, and, sql } from 'drizzle-orm';
import {
  assertBalancedJournalLines,
  buildCustomerPaymentLines,
  buildSupplierPaymentDiscountLines,
  getCustomerReceiptAccountNumber,
} from './liteAccountingRules.js';

const JOURNAL_CODES = {
  ACHATS: 'AC',
  VENTES: 'VT',
  BANQUE: 'BQ',
  CAISSE: 'CA',
  OD: 'OD'
};

const COMPTES_SYSCOHADA = {
  STOCK_MARCHANDISES: '31',
  FOURNISSEURS: '401',
  FOURNISSEURS_FACTURES_NON_PARVENUES: '408',
  CLIENTS: '411',
  PERSONNEL_AVANCES: '421',
  ETAT_TVA_DUE: '4434',
  ETAT_IMPOTS: '44',
  BANQUE: '52',
  CAISSE: '57',
  ACHATS_MARCHANDISES: '601',
  ACHATS_SERVICES: '61',
  AUTRES_CHARGES_EXTERNES: '62',
  // Ventilation des dépenses Lite par catégorie (plan SYSCOHADA de Lite) :
  // loyer -> 613 Locations et charges locatives, transport -> 624,
  // électricité/eau -> 6051, fournitures de bureau -> 6053, etc.
  CHARGE_LOYER: '613',
  CHARGE_TRANSPORT: '624',
  CHARGE_ELECTRICITE_EAU: '6051',
  CHARGE_FOURNITURES_BUREAU: '6053',
  CHARGE_TELECOMMUNICATION: '625',
  CHARGE_HONORAIRES: '6226',
  CHARGE_PUBLICITE: '623',
  CHARGE_ENTRETIEN: '615',
  CHARGE_ASSURANCE: '616',
  CHARGE_FRAIS_BANCAIRES: '626',
  CHARGE_PERSONNEL: '641',
  CHARGE_IMPOTS: '631',
  CHARGES_PERSONNEL: '64',
  IMPOTS_TAXES: '64',
  VENTES_MARCHANDISES: '701',
  TVA_DEDUCTIBLE: '445',
  TVA_COLLECTEE: '443',
  ECARTS_PRIX: '603'
};

export async function getOrCreateJournal(entrepriseId, code, nom, type, executor = db) {
  let journal = await executor.select().from(journaux)
    .where(and(eq(journaux.entrepriseId, entrepriseId), eq(journaux.code, code)))
    .limit(1);
  
  if (journal.length === 0) {
    const [newJournal] = await executor.insert(journaux).values({
      entrepriseId,
      code,
      nom,
      type,
      actif: true
    }).returning();
    return newJournal;
  }
  return journal[0];
}

export async function getCompteByNumero(entrepriseId, numero, executor = db) {
  const comptes = await executor.select().from(comptesComptables)
    .where(and(
      eq(comptesComptables.entrepriseId, entrepriseId),
      sql`${comptesComptables.numero} LIKE ${numero + '%'}`
    ))
    .limit(1);
  return comptes[0] || null;
}

export async function getCompteById(compteId, executor = db) {
  const [compte] = await executor.select().from(comptesComptables)
    .where(eq(comptesComptables.id, compteId));
  return compte;
}

export async function generateNumeroEcriture(entrepriseId, journalCode, executor = db) {
  const params = await executor.select().from(parametresComptables)
    .where(eq(parametresComptables.entrepriseId, entrepriseId))
    .limit(1);
  
  const prefix = params[0]?.prefixeEcritures || 'EC';
  const year = new Date().getFullYear();
  
  const count = await executor.select({ count: sql`COUNT(*)` })
    .from(ecritures)
    .where(and(
      eq(ecritures.entrepriseId, entrepriseId),
      sql`EXTRACT(YEAR FROM ${ecritures.dateEcriture}) = ${year}`
    ));
  
  const nextNum = (parseInt(count[0]?.count || 0) + 1).toString().padStart(5, '0');
  return `${journalCode}-${year}-${nextNum}`;
}

export async function createEcritureComptable(params) {
  const {
    entrepriseId,
    journalCode,
    journalNom,
    journalType,
    dateEcriture,
    libelle,
    numeroPiece,
    lignes,
    valide = false,
    sourceType = null,
    sourceId = null,
    executor = db
  } = params;

  const journal = await getOrCreateJournal(entrepriseId, journalCode, journalNom, journalType, executor);
  const numeroEcriture = await generateNumeroEcriture(entrepriseId, journalCode, executor);

  if (!Array.isArray(lignes) || lignes.length < 2) {
    throw new Error('Une écriture comptable doit contenir au moins deux lignes');
  }

  const lignesResolues = [];
  for (const ligne of lignes) {
    let compteId = ligne.compteComptableId;
    if (!compteId && ligne.numeroCompte) {
      const compte = await getCompteByNumero(entrepriseId, ligne.numeroCompte, executor);
      compteId = compte?.id;
    }
    if (!compteId) {
      throw new Error(`Compte comptable introuvable pour la ligne « ${ligne.libelle || libelle} »`);
    }

    const [compteValide] = await executor.select({ id: comptesComptables.id })
      .from(comptesComptables)
      .where(and(
        eq(comptesComptables.id, Number(compteId)),
        eq(comptesComptables.entrepriseId, entrepriseId),
      ))
      .limit(1);
    if (!compteValide) {
      throw new Error(`Le compte comptable ${compteId} n’appartient pas à cette entreprise`);
    }

    const debit = Number(ligne.debit || 0);
    const credit = Number(ligne.credit || 0);
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0
      || (debit > 0 && credit > 0)) {
      throw new Error('Montants de ligne comptable invalides');
    }
    lignesResolues.push({ ...ligne, compteComptableId: Number(compteId), debit, credit });
  }

  const totals = assertBalancedJournalLines(lignesResolues);
  const totalDebit = totals.debit;
  const totalCredit = totals.credit;

  const [ecriture] = await executor.insert(ecritures).values({
    entrepriseId,
    journalId: journal.id,
    numeroEcriture,
    dateEcriture,
    libelle,
    numeroPiece,
    valide,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2)
  }).returning();

  for (const ligne of lignesResolues) {
    await executor.insert(lignesEcritures).values({
      ecritureId: ecriture.id,
      compteComptableId: ligne.compteComptableId,
      debit: ligne.debit.toFixed(2),
      credit: ligne.credit.toFixed(2),
      libelle: ligne.libelle || libelle,
      entrepriseId
    });
  }

  return ecriture;
}

export async function createEcritureReception(params) {
  const {
    entrepriseId,
    receptionNumero,
    dateReception,
    fournisseurNom,
    totalHT
  } = params;

  const compteStock = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.STOCK_MARCHANDISES);
  const compte408 = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.FOURNISSEURS_FACTURES_NON_PARVENUES);

  if (!compteStock || !compte408) {
    console.warn('Comptes comptables (31x ou 408) non configurés pour entreprise', entrepriseId);
    return null;
  }

  const ecrituresLignes = [
    {
      compteComptableId: compteStock.id,
      debit: totalHT,
      credit: 0,
      libelle: `Stock réceptionné - ${receptionNumero}`
    },
    {
      compteComptableId: compte408.id,
      debit: 0,
      credit: totalHT,
      libelle: `Fournisseur facture non parvenue - ${fournisseurNom}`
    }
  ];

  return createEcritureComptable({
    entrepriseId,
    journalCode: JOURNAL_CODES.ACHATS,
    journalNom: 'Journal des Achats',
    journalType: 'achats',
    dateEcriture: dateReception,
    libelle: `Réception ${receptionNumero} - ${fournisseurNom}`,
    numeroPiece: receptionNumero,
    lignes: ecrituresLignes,
    valide: false
  });
}

export async function createEcritureFactureAchat(params) {
  const {
    entrepriseId,
    numeroFacture,
    dateFacture,
    fournisseurNom,
    fournisseurCompteId,
    totalHT,
    totalTVA = 0,
    totalTTC,
    montantPending = 0,
    ecartPrix = 0
  } = params;

  const compte401 = fournisseurCompteId ? await getCompteById(fournisseurCompteId) : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.FOURNISSEURS);
  const compte408 = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.FOURNISSEURS_FACTURES_NON_PARVENUES);
  const compteTVA = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.TVA_DEDUCTIBLE);
  const compteEcarts = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.ECARTS_PRIX);
  const compteAchats = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.ACHATS_MARCHANDISES);

  const ecrituresLignes = [];

  if (montantPending > 0 && compte408) {
    ecrituresLignes.push({
      compteComptableId: compte408.id,
      debit: montantPending,
      credit: 0,
      libelle: `Régularisation facture non parvenue - ${numeroFacture}`
    });
  }

  if (ecartPrix !== 0 && compteEcarts) {
    if (ecartPrix > 0) {
      ecrituresLignes.push({
        compteComptableId: compteEcarts.id,
        debit: Math.abs(ecartPrix),
        credit: 0,
        libelle: `Écart de prix défavorable - ${numeroFacture}`
      });
    } else {
      ecrituresLignes.push({
        compteComptableId: compteEcarts.id,
        debit: 0,
        credit: Math.abs(ecartPrix),
        libelle: `Écart de prix favorable - ${numeroFacture}`
      });
    }
  }

  if (montantPending === 0 && compteAchats) {
    ecrituresLignes.push({
      compteComptableId: compteAchats.id,
      debit: totalHT,
      credit: 0,
      libelle: `Achat marchandises - ${numeroFacture}`
    });
  }

  if (totalTVA > 0 && compteTVA) {
    ecrituresLignes.push({
      compteComptableId: compteTVA.id,
      debit: totalTVA,
      credit: 0,
      libelle: `TVA déductible - ${numeroFacture}`
    });
  }

  if (compte401) {
    ecrituresLignes.push({
      compteComptableId: compte401.id,
      debit: 0,
      credit: totalTTC,
      libelle: `Fournisseur ${fournisseurNom} - ${numeroFacture}`
    });
  }

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables configurés pour créer écriture facture achat');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode: JOURNAL_CODES.ACHATS,
    journalNom: 'Journal des Achats',
    journalType: 'achats',
    dateEcriture: dateFacture,
    libelle: `Facture ${numeroFacture} - ${fournisseurNom}`,
    numeroPiece: numeroFacture,
    lignes: ecrituresLignes,
    valide: false
  });
}

export async function createEcritureFactureVente(params) {
  const {
    entrepriseId,
    numeroFacture,
    dateFacture,
    clientNom,
    clientCompteId,
    totalHT,
    totalTVA = 0,
    totalTTC,
    valide = false,
    executor = db
  } = params;

  const compte411 = clientCompteId ? await getCompteById(clientCompteId, executor) : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CLIENTS, executor);
  const compteVentes = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.VENTES_MARCHANDISES, executor);
  const compteTVA = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.TVA_COLLECTEE, executor);

  const ecrituresLignes = [];

  if (compte411) {
    ecrituresLignes.push({
      compteComptableId: compte411.id,
      debit: totalTTC,
      credit: 0,
      libelle: `Client ${clientNom} - ${numeroFacture}`
    });
  }

  if (compteVentes) {
    ecrituresLignes.push({
      compteComptableId: compteVentes.id,
      debit: 0,
      credit: totalHT,
      libelle: `Vente marchandises - ${numeroFacture}`
    });
  }

  if (totalTVA > 0 && compteTVA) {
    ecrituresLignes.push({
      compteComptableId: compteTVA.id,
      debit: 0,
      credit: totalTVA,
      libelle: `TVA collectée - ${numeroFacture}`
    });
  }

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables configurés pour créer écriture facture vente');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode: JOURNAL_CODES.VENTES,
    journalNom: 'Journal des Ventes',
    journalType: 'ventes',
    dateEcriture: dateFacture,
    libelle: `Facture ${numeroFacture} - ${clientNom}`,
    numeroPiece: numeroFacture,
    lignes: ecrituresLignes,
    valide,
    executor
  });
}

export async function createEcriturePaiementFournisseur(params) {
  const {
    entrepriseId,
    reference,
    datePaiement,
    fournisseurNom,
    fournisseurCompteId,
    montant,
    modePaiement,
    compteBancaireId,
    escompteMontant = 0,
    executor = db
  } = params;

  const journalCode = modePaiement === 'especes' ? JOURNAL_CODES.CAISSE : JOURNAL_CODES.BANQUE;
  const journalNom = modePaiement === 'especes' ? 'Journal de Caisse' : 'Journal de Banque';
  
  const compte401 = fournisseurCompteId ? await getCompteById(fournisseurCompteId, executor) : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.FOURNISSEURS, executor);
  const compteTresorerie = modePaiement === 'especes' 
    ? await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CAISSE, executor)
    : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.BANQUE, executor);
  const compteEscompte = Number(escompteMontant) > 0
    ? await getCompteByNumero(entrepriseId, '765', executor)
    : null;
  const ecrituresLignes = compte401 && compteTresorerie && (Number(escompteMontant) <= 0 || compteEscompte)
    ? buildSupplierPaymentDiscountLines({
      supplierAccountId: compte401.id,
      settlementAccountId: compteTresorerie.id,
      discountAccountId: compteEscompte?.id,
      amount: montant,
      discountAmount: escompteMontant,
      modePaiement,
      reference,
    })
    : [];

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables pour créer écriture paiement fournisseur');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode,
    journalNom,
    journalType: modePaiement === 'especes' ? 'caisse' : 'banque',
    dateEcriture: datePaiement,
    libelle: `Paiement ${fournisseurNom} - ${reference}`,
    numeroPiece: reference,
    lignes: ecrituresLignes,
    valide: false,
    executor
  });
}

export async function createEcriturePaiementClient(params) {
  const {
    entrepriseId,
    reference,
    datePaiement,
    clientNom,
    clientCompteId,
    montant,
    modePaiement,
    compteBancaireId,
    escompteMontant = 0,
    executor = db
  } = params;

  const journalCode = modePaiement === 'especes' ? JOURNAL_CODES.CAISSE : JOURNAL_CODES.BANQUE;
  const journalNom = modePaiement === 'especes' ? 'Journal de Caisse' : 'Journal de Banque';

  const compte411 = clientCompteId ? await getCompteById(clientCompteId, executor) : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CLIENTS, executor);
  const compteNumero = getCustomerReceiptAccountNumber(modePaiement);
  const compteTresorerie = await getCompteByNumero(entrepriseId, compteNumero, executor);
  const compteEscompte = Number(escompteMontant) > 0
    ? await getCompteByNumero(entrepriseId, '665', executor)
    : null;
  const ecrituresLignes = compteTresorerie && compte411 && (Number(escompteMontant) <= 0 || compteEscompte)
    ? buildCustomerPaymentLines({
      settlementAccountId: compteTresorerie.id,
      customerAccountId: compte411.id,
      discountAccountId: compteEscompte?.id,
      amount: montant,
      discountAmount: escompteMontant,
      modePaiement,
      reference,
    })
    : [];

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables pour créer écriture paiement client');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode,
    journalNom,
    journalType: modePaiement === 'especes' ? 'caisse' : 'banque',
    dateEcriture: datePaiement,
    libelle: `Encaissement ${clientNom} - ${reference}`,
    numeroPiece: reference,
    lignes: ecrituresLignes,
    valide: false,
    executor
  });
}

export async function createEcritureDepense(params) {
  const {
    entrepriseId,
    reference,
    dateRemboursement,
    employeNom,
    description,
    montant,
    modePaiement,
    categorieCompte
  } = params;

  const journalCode = modePaiement === 'especes' ? JOURNAL_CODES.CAISSE : JOURNAL_CODES.BANQUE;
  const journalNom = modePaiement === 'especes' ? 'Journal de Caisse' : 'Journal de Banque';

  // Pour le remboursement d'une dépense employé:
  // - On débite le compte Personnel - Avances (421) pour solder l'avance faite par l'employé
  // - On crédite la trésorerie (52 ou 57) pour le décaissement
  // Note: La charge a déjà été comptabilisée lors de l'approbation de la dépense
  const compteAvance = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.PERSONNEL_AVANCES);
  const compteTresorerie = modePaiement === 'especes' 
    ? await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CAISSE)
    : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.BANQUE);

  const ecrituresLignes = [];

  if (compteAvance) {
    ecrituresLignes.push({
      compteComptableId: compteAvance.id,
      debit: montant,
      credit: 0,
      libelle: `Remboursement avance ${employeNom}`
    });
  }

  if (compteTresorerie) {
    ecrituresLignes.push({
      compteComptableId: compteTresorerie.id,
      debit: 0,
      credit: montant,
      libelle: `Décaissement remboursement ${employeNom}`
    });
  }

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables pour créer écriture dépense');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode,
    journalNom,
    journalType: modePaiement === 'especes' ? 'caisse' : 'banque',
    dateEcriture: dateRemboursement,
    libelle: `Remboursement dépense ${employeNom} - ${description}`,
    numeroPiece: reference,
    lignes: ecrituresLignes,
    valide: false
  });
}

// Ventilation des dépenses Lite par catégorie (SYSCOHADA).
// On regarde d'abord le nom de la catégorie, puis le libellé de la dépense
// (la catégorie de repli « Divers » ne dit rien du contenu).
// Comptes du plan Lite : loyer 613, transport 624, électricité/eau 6051.
// Repli : 62 « Autres services extérieurs » (comportement historique).
const REGLES_COMPTE_CHARGE_LITE = [
  { mots: ['loyer', 'location', 'bail', 'immobilier', 'loyers'], compte: '613' },
  { mots: ['transport', 'deplacement', 'carburant', 'essence', 'voyage', 'mission', 'reception'], compte: '624' },
  { mots: ['electricite', 'eau', 'energie'], compte: '6051' },
  { mots: ['fourniture', 'papeterie', 'bureau'], compte: '6053' },
  { mots: ['telephone', 'telecommunication', 'internet', 'telecom'], compte: '625' },
  { mots: ['honoraire', 'avocat', 'expert', 'consultant', 'intermediaire', 'notaire', 'comptable'], compte: '6226' },
  { mots: ['publicite', 'marketing', 'communication', 'affiche'], compte: '623' },
  { mots: ['entretien', 'reparation', 'maintenance'], compte: '615' },
  { mots: ['assurance'], compte: '616' },
  { mots: ['bancaire', 'banque', 'frais bancaire'], compte: '626' },
  { mots: ['salaire', 'personnel', 'paie', 'remuneration'], compte: '641' },
  { mots: ['impot', 'taxe', 'patente'], compte: '631' },
];

function normaliserTexteCharge(texte) {
  return String(texte || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ');
}

export function resolveCompteChargeLite(categorieNom, description) {
  // Correspondance par mot : un mot-clé correspond si un mot du texte
  // l'égale ou commence par lui (« honoraires », « fournitures », « loyers »).
  // « eau » ne correspond donc pas à « nouveau » (le mot ne commence pas par « eau »).
  const mots = `${normaliserTexteCharge(categorieNom)} ${normaliserTexteCharge(description)}`.split(/\s+/).filter(Boolean);
  for (const regle of REGLES_COMPTE_CHARGE_LITE) {
    if (regle.mots.some((mot) => mots.some((motTexte) => motTexte === mot || motTexte.startsWith(mot)))) return regle.compte;
  }
  return COMPTES_SYSCOHADA.AUTRES_CHARGES_EXTERNES;
}

export async function createEcritureDepenseLite(params) {
  const {
    entrepriseId,
    reference,
    dateDepense,
    description,
    montant,
    modePaiement = 'especes',
    categorieNom = null,
    executor = db
  } = params;

  // Ventile la charge par catégorie (613 loyer, 624 transport, 6051 électricité…).
  // Repli sur 62 si le compte ciblé n'existe pas dans le plan de l'entreprise.
  const numeroCharge = resolveCompteChargeLite(categorieNom, description);
  let compteCharge = await getCompteByNumero(entrepriseId, numeroCharge, executor);
  if (!compteCharge) compteCharge = await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.AUTRES_CHARGES_EXTERNES, executor);
  const compteTresorerie = modePaiement === 'especes'
    ? await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CAISSE, executor)
    : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.BANQUE, executor);

  if (!compteCharge || !compteTresorerie) {
    throw new Error('Les comptes de charge et de trésorerie doivent être configurés avant d’enregistrer cette dépense.');
  }

  const journalCode = modePaiement === 'especes' ? JOURNAL_CODES.CAISSE : JOURNAL_CODES.BANQUE;
  const journalNom = modePaiement === 'especes' ? 'Journal de Caisse' : 'Journal de Banque';

  return createEcritureComptable({
    entrepriseId,
    journalCode,
    journalNom,
    journalType: modePaiement === 'especes' ? 'caisse' : 'banque',
    dateEcriture: dateDepense,
    libelle: `Dépense Lite - ${description}`,
    numeroPiece: reference,
    lignes: [
      { compteComptableId: compteCharge.id, debit: montant, credit: 0, libelle: description },
      { compteComptableId: compteTresorerie.id, debit: 0, credit: montant, libelle: description }
    ],
    // Les dépenses Lite sont approuvées à la création : elles sont validées
    // comme les ventes (sinon l'état de résultat reste « provisoire » sans
    // aucun parcours de validation dans Lite).
    valide: true,
    executor
  });
}

export async function createEcriturePaiementImpot(params) {
  const {
    entrepriseId,
    reference,
    datePaiement,
    typeImpot,
    montant,
    periode,
    modePaiement = 'virement'
  } = params;

  const journalCode = modePaiement === 'especes' ? JOURNAL_CODES.CAISSE : JOURNAL_CODES.BANQUE;
  const journalNom = modePaiement === 'especes' ? 'Journal de Caisse' : 'Journal de Banque';

  // Pour TVA: débiter le compte 4434 (TVA due à l'État) pour solder la dette fiscale
  // Pour autres impôts: débiter le compte 44 (État et collectivités)
  const compteImpot = typeImpot === 'tva' 
    ? await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.ETAT_TVA_DUE)
    : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.ETAT_IMPOTS);
  
  const compteTresorerie = modePaiement === 'especes' 
    ? await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.CAISSE)
    : await getCompteByNumero(entrepriseId, COMPTES_SYSCOHADA.BANQUE);

  const ecrituresLignes = [];

  if (compteImpot) {
    ecrituresLignes.push({
      compteComptableId: compteImpot.id,
      debit: montant,
      credit: 0,
      libelle: `Paiement ${typeImpot.toUpperCase()} ${periode}`
    });
  }

  if (compteTresorerie) {
    ecrituresLignes.push({
      compteComptableId: compteTresorerie.id,
      debit: 0,
      credit: montant,
      libelle: `Règlement impôt ${typeImpot.toUpperCase()}`
    });
  }

  if (ecrituresLignes.length < 2) {
    console.warn('Pas assez de comptes comptables pour créer écriture paiement impôt');
    return null;
  }

  return createEcritureComptable({
    entrepriseId,
    journalCode,
    journalNom,
    journalType: modePaiement === 'especes' ? 'caisse' : 'banque',
    dateEcriture: datePaiement,
    libelle: `Paiement ${typeImpot.toUpperCase()} - ${periode}`,
    numeroPiece: reference,
    lignes: ecrituresLignes,
    valide: false
  });
}

export default {
  JOURNAL_CODES,
  COMPTES_SYSCOHADA,
  getOrCreateJournal,
  getCompteByNumero,
  createEcritureComptable,
  createEcritureReception,
  createEcritureFactureAchat,
  createEcritureFactureVente,
  createEcriturePaiementFournisseur,
  createEcriturePaiementClient,
  createEcritureDepense,
  createEcriturePaiementImpot
};
