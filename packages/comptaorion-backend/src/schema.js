import { pgTable, serial, text, varchar, integer, decimal, boolean, timestamp, date, pgEnum, jsonb, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ==========================================
// ENUMS
// ==========================================

export const userRoleEnum = pgEnum('user_role', ['admin', 'manager', 'accountant', 'employee', 'viewer']);
export const transactionTypeEnum = pgEnum('transaction_type', ['encaissement', 'decaissement']);
export const orderStatusEnum = pgEnum('order_status', ['brouillon', 'confirmee', 'preparee', 'livree', 'annulee']);
export const quoteStatusEnum = pgEnum('quote_status', ['brouillon', 'envoyee', 'acceptee', 'refusee', 'expiree']);
export const invoiceStatusEnum = pgEnum('invoice_status', ['brouillon', 'envoyee', 'payee', 'annulee', 'retard']);
export const expenseStatusEnum = pgEnum('expense_status', ['brouillon', 'soumise', 'approuvee', 'rejetee', 'remboursee']);
export const stockMovementTypeEnum = pgEnum('stock_movement_type', ['entree', 'sortie', 'transfert', 'ajustement']);
export const journalTypeEnum = pgEnum('journal_type', ['achats', 'ventes', 'banque', 'caisse', 'od']);
export const systemeComptableEnum = pgEnum('systeme_comptable', ['SYSCOHADA', 'IFRS', 'PCG']);
export const emailStatusEnum = pgEnum('email_status', ['envoye', 'echec', 'en_attente']);
export const receptionStatusEnum = pgEnum('reception_status', ['brouillon', 'validee', 'facturee', 'annulee']);

// ==========================================
// MODULE 9: MULTI-ENTREPRISE & ADMINISTRATION
// ==========================================

export const entreprises = pgTable('entreprises', {
  id: serial('id').primaryKey(),
  nom: varchar('nom', { length: 255 }).notNull(),
  raisonSociale: varchar('raison_sociale', { length: 255 }),
  numeroSiret: varchar('numero_siret', { length: 50 }),
  adresse: text('adresse'),
  ville: varchar('ville', { length: 100 }),
  pays: varchar('pays', { length: 100 }).default('Côte d\'Ivoire'),
  telephone: varchar('telephone', { length: 50 }),
  email: varchar('email', { length: 255 }),
  
  // Paramètres financiers et comptables
  devise: varchar('devise', { length: 10 }).default('FCFA'), // FCFA, EUR, USD, GBP, CAD, etc.
  symboleDevise: varchar('symbole_devise', { length: 10 }).default('FCFA'),
  tauxTva: decimal('taux_tva', { precision: 5, scale: 2 }).default('18.00'),
  systemeComptable: systemeComptableEnum('systeme_comptable').default('SYSCOHADA'), // SYSCOHADA, IFRS, PCG
  
  // Année fiscale
  debutAnneeFiscale: date('debut_annee_fiscale').default('2025-01-01'),
  finAnneeFiscale: date('fin_annee_fiscale').default('2025-12-31'),
  
  // Autres paramètres
  numeroTva: varchar('numero_tva', { length: 50 }),
  registreCommerce: varchar('registre_commerce', { length: 100 }),
  codeNaf: varchar('code_naf', { length: 20 }),
  formeJuridique: varchar('forme_juridique', { length: 100 }), // SARL, SA, EURL, etc.
  
  logoUrl: text('logo_url'),
  
  // Paramètres de personnalisation des factures
  factureFooterText: text('facture_footer_text'),
  factureMentionsLegales: text('facture_mentions_legales'),
  factureCouleurPrincipale: varchar('facture_couleur_principale', { length: 7 }).default('#3498db'),
  factureAfficherLogo: boolean('facture_afficher_logo').default(true),
  
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const liteIdempotency = pgTable('lite_idempotency', {
  entrepriseId: integer('entreprise_id').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('processing'),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.entrepriseId, table.idempotencyKey] }),
  keyUnique: uniqueIndex('lite_idempotency_key_unique').on(table.idempotencyKey),
}));

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  username: varchar('username', { length: 100 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nom: varchar('nom', { length: 100 }),
  prenom: varchar('prenom', { length: 100 }),
  role: userRoleEnum('role').default('employee'),
  actif: boolean('actif').default(true),
  lastLogin: timestamp('last_login'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE 4: CLIENTS & CRM
// ==========================================

export const clients = pgTable('clients', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  compteComptableId: integer('compte_comptable_id'),
  codeAuxiliaire: varchar('code_auxiliaire', { length: 20 }),
  numeroClient: varchar('numero_client', { length: 50 }).unique(),
  nom: varchar('nom', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).default('particulier'), // particulier, entreprise
  email: varchar('email', { length: 255 }),
  telephone: varchar('telephone', { length: 50 }),
  adresse: text('adresse'),
  ville: varchar('ville', { length: 100 }),
  pays: varchar('pays', { length: 100 }),
  categorieClient: varchar('categorie_client', { length: 100 }).default('standard'),
  limiteCredit: decimal('limite_credit', { precision: 15, scale: 2 }).default('0'),
  delaiPaiement: integer('delai_paiement').default(30), // jours
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'), // %
  soldeDu: decimal('solde_du', { precision: 15, scale: 2 }).default('0'),
  echeancesPersonnalisees: jsonb('echeances_personnalisees'), // [{jours: 30, pourcentage: 100}]
  modesPaiementPreferes: jsonb('modes_paiement_preferes'), // ['mobile_money', 'carte_bancaire']
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE 5: FOURNISSEURS
// ==========================================

export const fournisseurs = pgTable('fournisseurs', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  compteComptableId: integer('compte_comptable_id'),
  codeAuxiliaire: varchar('code_auxiliaire', { length: 20 }),
  numeroFournisseur: varchar('numero_fournisseur', { length: 50 }).unique(),
  raisonSociale: varchar('raison_sociale', { length: 255 }).notNull(),
  contactPrincipal: varchar('contact_principal', { length: 255 }),
  fonction: varchar('fonction', { length: 100 }),
  email: varchar('email', { length: 255 }),
  telephone: varchar('telephone', { length: 50 }),
  adresse: text('adresse'),
  categorie: varchar('categorie', { length: 100 }),
  delaiPaiement: integer('delai_paiement').default(30),
  compteBancaire: varchar('compte_bancaire', { length: 100 }),
  banque: varchar('banque', { length: 255 }),
  soldeDu: decimal('solde_du', { precision: 15, scale: 2 }).default('0'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Tables pour les commandes d'achat (ACHATS FOURNISSEURS)
export const commandesAchat = pgTable('commandes_achat', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroCommande: varchar('numero_commande', { length: 100 }).unique(),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id).notNull(),
  statut: varchar('statut', { length: 50 }).default('brouillon'), // brouillon, confirmee, recue_partiel, recue, facturee, annulee
  dateCommande: date('date_commande').defaultNow(),
  dateLivraisonPrevue: date('date_livraison_prevue'),
  totalArticlesHT: decimal('total_articles_ht', { precision: 15, scale: 2 }).default('0'),
  totalLogistique: decimal('total_logistique', { precision: 15, scale: 2 }).default('0'),
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  totalTVA: decimal('total_tva', { precision: 15, scale: 2 }).default('0'),
  totalTTC: decimal('total_ttc', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  conditionsLivraison: text('conditions_livraison'),
  modeLivraison: varchar('mode_livraison', { length: 100 }),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const commandesAchatItems = pgTable('commandes_achat_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  commandeId: integer('commande_id').references(() => commandesAchat.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id),
  description: text('description').notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  quantiteRecue: decimal('quantite_recue', { precision: 15, scale: 3 }).default('0'),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }).notNull(),
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'),
  totalLigne: decimal('total_ligne', { precision: 15, scale: 2 }).notNull(),
});

// Tables pour les factures fournisseurs
export const facturesAchat = pgTable('factures_achat', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroFacture: varchar('numero_facture', { length: 100 }).unique(),
  numeroFactureFournisseur: varchar('numero_facture_fournisseur', { length: 100 }),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id).notNull(),
  commandeId: integer('commande_id'),
  statut: varchar('statut', { length: 50 }).default('brouillon'),
  dateFacture: date('date_facture').defaultNow(),
  dateEcheance: date('date_echeance'),
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  totalTVA: decimal('total_tva', { precision: 15, scale: 2 }).default('0'),
  totalTTC: decimal('total_ttc', { precision: 15, scale: 2 }).default('0'),
  montantPaye: decimal('montant_paye', { precision: 15, scale: 2 }).default('0'),
  soldeRestant: decimal('solde_restant', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const factureAchatItems = pgTable('facture_achat_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  factureId: integer('facture_id').references(() => facturesAchat.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id),
  description: text('description').notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }).notNull(),
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'),
  totalLigne: decimal('total_ligne', { precision: 15, scale: 2 }).notNull(),
});

export const paiementsFournisseurs = pgTable('paiements_fournisseurs', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  factureId: integer('facture_id').references(() => facturesAchat.id),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  modePaiement: varchar('mode_paiement', { length: 100 }),
  reference: varchar('reference', { length: 255 }),
  datePaiement: date('date_paiement').defaultNow(),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 6: STOCK & INVENTAIRE
// ==========================================

// Catégories de produits avec codes comptables
export const categoriesStock = pgTable('categories_stock', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  description: text('description'),
  codeCategorie: varchar('code_categorie', { length: 20 }),
  compteVentesId: integer('compte_ventes_id'),
  compteAchatsId: integer('compte_achats_id'),
  compteStockId: integer('compte_stock_id'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Entrepôts / Magasins
export const entrepots = pgTable('entrepots', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  adresse: text('adresse'),
  responsable: varchar('responsable', { length: 100 }),
  telephone: varchar('telephone', { length: 50 }),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const produits = pgTable('produits', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  reference: varchar('reference', { length: 100 }).unique(),
  nom: varchar('nom', { length: 255 }).notNull(),
  description: text('description'),
  categoriId: integer('categorie_id').references(() => categoriesStock.id),
  uniteMesure: varchar('unite_mesure', { length: 50 }).default('pièce'),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).default('0'),
  stockMinimum: decimal('stock_minimum', { precision: 15, scale: 3 }).default('0'),
  prixAchat: decimal('prix_achat', { precision: 15, scale: 2 }).default('0'),
  prixVente: decimal('prix_vente', { precision: 15, scale: 2 }).default('0'),
  coutMoyen: decimal('cout_moyen', { precision: 15, scale: 2 }).default('0'),
  valorisationMethod: varchar('valorisation_method', { length: 20 }).default('CMP'),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Stock par entrepôt (multi-entrepôts)
export const stockParEntrepot = pgTable('stock_par_entrepot', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  entrepotId: integer('entrepot_id').references(() => entrepots.id).notNull(),
  quantitePresente: decimal('quantite_presente', { precision: 15, scale: 3 }).default('0'),
  quantiteReservee: decimal('quantite_reservee', { precision: 15, scale: 3 }).default('0'),
  quantiteDisponible: decimal('quantite_disponible', { precision: 15, scale: 3 }).default('0'),
  emplacement: varchar('emplacement', { length: 255 }),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const mouvementsStock = pgTable('mouvements_stock', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  type: stockMovementTypeEnum('type').notNull(), // entree, sortie, transfert, ajustement
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }),
  reference: varchar('reference', { length: 255 }),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// Valorisation du stock (FIFO/CMP)
export const valorisationsStock = pgTable('valorisations_stock', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  mouvementId: integer('mouvement_id').references(() => mouvementsStock.id),
  methode: varchar('methode', { length: 20 }).notNull(), // FIFO, CMP
  coutUnitaire: decimal('cout_unitaire', { precision: 15, scale: 2 }).notNull(),
  coutTotal: decimal('cout_total', { precision: 15, scale: 2 }).notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Inventaires tournants
export const inventairesTournants = pgTable('inventaires_tournants', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  entrepotId: integer('entrepot_id').references(() => entrepots.id).notNull(),
  numero: varchar('numero', { length: 100 }).unique(),
  dateDebut: date('date_debut').notNull(),
  dateFin: date('date_fin'),
  statut: varchar('statut', { length: 50 }).default('en_cours'), // en_cours, termine, valide
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const lignInventairesTournants = pgTable('ligne_inventaires_tournants', {
  id: serial('id').primaryKey(),
  inventaireId: integer('inventaire_id').references(() => inventairesTournants.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  quantiteSysteme: decimal('quantite_systeme', { precision: 15, scale: 3 }).notNull(),
  quantiteComptee: decimal('quantite_comptee', { precision: 15, scale: 3 }).notNull(),
  ecart: decimal('ecart', { precision: 15, scale: 3 }).default('0'),
});

// Alertes de stock
export const alertesStock = pgTable('alertes_stock', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  entrepotId: integer('entrepot_id').references(() => entrepots.id),
  type: varchar('type', { length: 50 }).notNull(), // seuil_min, rupture, surstock
  quantiteActuelle: decimal('quantite_actuelle', { precision: 15, scale: 3 }).notNull(),
  seuil: decimal('seuil', { precision: 15, scale: 3 }).notNull(),
  statut: varchar('statut', { length: 50 }).default('active'),
  dateAlerte: timestamp('date_alerte').defaultNow(),
  dateResolution: timestamp('date_resolution'),
});

// ==========================================
// MODULE 11B: BONS DE RÉCEPTION (INVENTAIRE ACHATS)
// ==========================================

export const bonsReception = pgTable('bons_reception', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numero: varchar('numero', { length: 100 }).unique(),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id).notNull(),
  dateReception: date('date_reception').notNull(),
  statut: receptionStatusEnum('statut').default('brouillon'),
  
  entrepotId: integer('entrepot_id').references(() => entrepots.id),
  commandeAchatId: integer('commande_achat_id'),
  
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  
  ecritureStockId: integer('ecriture_stock_id'),
  factureAchatId: integer('facture_achat_id'),
  
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const lignesReception = pgTable('lignes_reception', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  bonReceptionId: integer('bon_reception_id').references(() => bonsReception.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  
  quantiteCommandee: decimal('quantite_commandee', { precision: 15, scale: 3 }).default('0'),
  quantiteRecue: decimal('quantite_recue', { precision: 15, scale: 3 }).notNull(),
  quantiteFacturee: decimal('quantite_facturee', { precision: 15, scale: 3 }).default('0'),
  
  prixUnitaireEstime: decimal('prix_unitaire_estime', { precision: 15, scale: 2 }).notNull(),
  prixUnitaireFacture: decimal('prix_unitaire_facture', { precision: 15, scale: 2 }),
  
  ecartPrix: decimal('ecart_prix', { precision: 15, scale: 2 }).default('0'),
  
  mouvementStockId: integer('mouvement_stock_id').references(() => mouvementsStock.id),
  
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 11C: COÛTS LOGISTIQUES (PURCHASE ORDERS)
// ==========================================

export const coutTypeEnum = pgEnum('cout_type', ['transport', 'douane', 'manutention', 'assurance', 'autre']);

export const coutsLogistiquesCommande = pgTable('couts_logistiques_commande', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  commandeAchatId: integer('commande_achat_id').references(() => commandesAchat.id).notNull(),
  
  type: coutTypeEnum('type').notNull(),
  description: text('description'),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 11D: STOCK & COÛTS NON FACTURÉS (PENDING)
// ==========================================

export const stockPending = pgTable('stock_pending', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  
  bonReceptionId: integer('bon_reception_id').references(() => bonsReception.id).notNull(),
  ligneReceptionId: integer('ligne_reception_id').references(() => lignesReception.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id).notNull(),
  
  quantitePending: decimal('quantite_pending', { precision: 15, scale: 3 }).notNull(),
  prixEstime: decimal('prix_estime', { precision: 15, scale: 2 }).notNull(),
  valeurEstimee: decimal('valeur_estimee', { precision: 15, scale: 2 }).notNull(),
  
  dateReception: date('date_reception').notNull(),
  entrepotId: integer('entrepot_id').references(() => entrepots.id),
  
  statut: varchar('statut', { length: 50 }).default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const logistiquePending = pgTable('logistique_pending', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  
  bonReceptionId: integer('bon_reception_id').references(() => bonsReception.id).notNull(),
  commandeAchatId: integer('commande_achat_id').references(() => commandesAchat.id),
  fournisseurId: integer('fournisseur_id').references(() => fournisseurs.id).notNull(),
  
  type: coutTypeEnum('type').notNull(),
  description: text('description'),
  montantEstime: decimal('montant_estime', { precision: 15, scale: 2 }).notNull(),
  montantFacture: decimal('montant_facture', { precision: 15, scale: 2 }),
  
  dateReception: date('date_reception').notNull(),
  
  statut: varchar('statut', { length: 50 }).default('pending'),
  factureAchatId: integer('facture_achat_id'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 12: PRISE DE COMMANDE
// ==========================================

export const commandes = pgTable('commandes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroCommande: varchar('numero_commande', { length: 100 }).unique(),
  clientId: integer('client_id').references(() => clients.id).notNull(),
  statut: orderStatusEnum('statut').default('brouillon'),
  dateCommande: date('date_commande').defaultNow(),
  dateLivraison: date('date_livraison'),
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  totalTVA: decimal('total_tva', { precision: 15, scale: 2 }).default('0'),
  totalTTC: decimal('total_ttc', { precision: 15, scale: 2 }).default('0'),
  remise: decimal('remise', { precision: 15, scale: 2 }).default('0'),
  fraisLivraison: decimal('frais_livraison', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const commandeItems = pgTable('commande_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  commandeId: integer('commande_id').references(() => commandes.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }).notNull(),
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'),
  totalLigne: decimal('total_ligne', { precision: 15, scale: 2 }).notNull(),
});

export const bonsLivraison = pgTable('bons_livraison', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroBL: varchar('numero_bl', { length: 100 }).unique(),
  commandeId: integer('commande_id').references(() => commandes.id),
  clientId: integer('client_id').references(() => clients.id).notNull(),
  dateLivraison: date('date_livraison').defaultNow(),
  signatureClient: text('signature_client'),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

export const bonLivraisonItems = pgTable('bon_livraison_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  bonLivraisonId: integer('bon_livraison_id').references(() => bonsLivraison.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
});

// ==========================================
// MODULE 4: FACTURATION & VENTES
// ==========================================

// Table Devis
export const devis = pgTable('devis', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroDevis: varchar('numero_devis', { length: 100 }).unique(),
  clientId: integer('client_id').references(() => clients.id).notNull(),
  statut: quoteStatusEnum('statut').default('brouillon'),
  dateDevis: date('date_devis').defaultNow(),
  dateExpiration: date('date_expiration'),
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  totalTVA: decimal('total_tva', { precision: 15, scale: 2 }).default('0'),
  totalTTC: decimal('total_ttc', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  conditionsVente: text('conditions_vente'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const devisItems = pgTable('devis_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  devisId: integer('devis_id').references(() => devis.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id),
  description: text('description').notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }).notNull(),
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'),
  totalLigne: decimal('total_ligne', { precision: 15, scale: 2 }).notNull(),
});

// Table Factures
export const factures = pgTable('factures', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numeroFacture: varchar('numero_facture', { length: 100 }).unique(),
  clientId: integer('client_id').references(() => clients.id).notNull(),
  commandeId: integer('commande_id').references(() => commandes.id),
  statut: invoiceStatusEnum('statut').default('brouillon'),
  dateFacture: date('date_facture').defaultNow(),
  dateEcheance: date('date_echeance'),
  totalHT: decimal('total_ht', { precision: 15, scale: 2 }).default('0'),
  totalTVA: decimal('total_tva', { precision: 15, scale: 2 }).default('0'),
  totalTTC: decimal('total_ttc', { precision: 15, scale: 2 }).default('0'),
  montantPaye: decimal('montant_paye', { precision: 15, scale: 2 }).default('0'),
  soldeRestant: decimal('solde_restant', { precision: 15, scale: 2 }).default('0'),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const factureItems = pgTable('facture_items', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  factureId: integer('facture_id').references(() => factures.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id),
  description: text('description').notNull(),
  quantite: decimal('quantite', { precision: 15, scale: 3 }).notNull(),
  prixUnitaire: decimal('prix_unitaire', { precision: 15, scale: 2 }).notNull(),
  remise: decimal('remise', { precision: 5, scale: 2 }).default('0'),
  totalLigne: decimal('total_ligne', { precision: 15, scale: 2 }).notNull(),
});

export const paiements = pgTable('paiements', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  factureId: integer('facture_id').references(() => factures.id),
  clientId: integer('client_id').references(() => clients.id),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  modePaiement: varchar('mode_paiement', { length: 100 }), // espèces, virement, mobile money, etc.
  reference: varchar('reference', { length: 255 }),
  datePaiement: date('date_paiement').defaultNow(),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 2: TRÉSORERIE
// ==========================================

export const comptesBancaires = pgTable('comptes_bancaires', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nomCompte: varchar('nom_compte', { length: 255 }).notNull(),
  numeroCompte: varchar('numero_compte', { length: 100 }),
  banque: varchar('banque', { length: 255 }),
  soldeInitial: decimal('solde_initial', { precision: 15, scale: 2 }).default('0'),
  soldeActuel: decimal('solde_actuel', { precision: 15, scale: 2 }).default('0'),
  type: varchar('type', { length: 50 }).default('banque'), // banque, caisse, mobile money
  compteComptableId: integer('compte_comptable_id').references(() => comptesComptables.id),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const transactionsTresorerie = pgTable('transactions_tresorerie', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  compteBancaireId: integer('compte_bancaire_id').references(() => comptesBancaires.id).notNull(),
  type: transactionTypeEnum('type').notNull(),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  dateTransaction: date('date_transaction').defaultNow(),
  categorie: varchar('categorie', { length: 100 }),
  description: text('description'),
  tiersNom: varchar('tiers_nom', { length: 255 }), // client ou fournisseur
  numeroPiece: varchar('numero_piece', { length: 100 }),
  modePaiement: varchar('mode_paiement', { length: 100 }),
  rapproche: boolean('rapproche').default(false),
  rapprochementId: integer('rapprochement_id').references(() => rapprochementsBancaires.id),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

export const rapprochementsBancaires = pgTable('rapprochements_bancaires', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  compteBancaireId: integer('compte_bancaire_id').references(() => comptesBancaires.id).notNull(),
  dateRapprochement: date('date_rapprochement').defaultNow(),
  dateDebut: date('date_debut').notNull(),
  dateFin: date('date_fin').notNull(),
  soldeReleve: decimal('solde_releve', { precision: 15, scale: 2 }).notNull(),
  soldeComptable: decimal('solde_comptable', { precision: 15, scale: 2 }).notNull(),
  ecart: decimal('ecart', { precision: 15, scale: 2 }).default('0'),
  statut: varchar('statut', { length: 50 }).default('en_cours'),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE 1: COMPTABILITÉ GÉNÉRALE
// ==========================================

export const comptesComptables = pgTable('comptes_comptables', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numero: varchar('numero', { length: 50 }).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // actif, passif, produit, charge, capitaux
  categorie: varchar('categorie', { length: 100 }), // bilan, résultat
  compteParent: varchar('compte_parent', { length: 50 }),
  soldeDebiteur: decimal('solde_debiteur', { precision: 15, scale: 2 }).default('0'),
  soldeCrediteur: decimal('solde_crediteur', { precision: 15, scale: 2 }).default('0'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 16: ORION EXPENSE - DEPENSES/NOTES DE FRAIS
// ==========================================

export const categoriesDepenses = pgTable('categories_depenses', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  description: text('description'),
  limiteApproval: decimal('limite_approval', { precision: 15, scale: 2 }).default('0'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const depenses = pgTable('depenses', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  employeId: integer('employe_id').references(() => users.id).notNull(),
  categorieId: integer('categorie_id').references(() => categoriesDepenses.id).notNull(),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  dateDepense: date('date_depense').notNull(),
  description: text('description'),
  justificatifUrl: text('justificatif_url'),
  recurrente: boolean('recurrente').default(false),
  frequenceRecurrence: varchar('frequence_recurrence', { length: 50 }),
  statut: varchar('statut', { length: 50 }).default('en_attente'),
  montantApprouve: decimal('montant_approuve', { precision: 15, scale: 2 }).default('0'),
  montantRembourse: decimal('montant_rembourse', { precision: 15, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const approvalsDepenses = pgTable('approvals_depenses', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  depenseId: integer('depense_id').references(() => depenses.id).notNull(),
  etape: varchar('etape', { length: 50 }).notNull(), // manager, comptable
  statut: varchar('statut', { length: 50 }).default('en_attente'), // en_attente, approuvée, rejetée
  approbateurId: integer('approbateur_id').references(() => users.id),
  dateApprobation: timestamp('date_approbation'),
  raison: text('raison'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Remboursements employés
export const remboursementsEmployes = pgTable('remboursements_employes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  depenseId: integer('depense_id').references(() => depenses.id).notNull(),
  montantRembourse: decimal('montant_rembourse', { precision: 15, scale: 2 }).notNull(),
  dateRemboursement: date('date_remboursement').notNull(),
  methodePaiement: varchar('methode_paiement', { length: 100 }), // virement, chèque, cash
  statut: varchar('statut', { length: 50 }).default('complété'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 7: EMPLOYÉS (ORION HR LITE)
// ==========================================

// Table employés (MODULE PAIE)
export const employes = pgTable('employes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  userId: integer('user_id').references(() => users.id),
  matricule: varchar('matricule', { length: 50 }).unique(),
  nom: varchar('nom', { length: 100 }).notNull(),
  prenom: varchar('prenom', { length: 100 }).notNull(),
  numeroCNPS: varchar('numero_cnps', { length: 50 }),
  dateNaissance: date('date_naissance'),
  lieuNaissance: varchar('lieu_naissance', { length: 100 }),
  nationalite: varchar('nationalite', { length: 50 }),
  telephone: varchar('telephone', { length: 50 }),
  email: varchar('email', { length: 255 }),
  adresse: text('adresse'),
  poste: varchar('poste', { length: 100 }),
  departement: varchar('departement', { length: 100 }),
  typeContrat: varchar('type_contrat', { length: 50 }).default('CDI'),
  dateEmbauche: date('date_embauche'),
  dateFinContrat: date('date_fin_contrat'),
  salaireBase: decimal('salaire_base', { precision: 15, scale: 2 }),
  indemnitesRegulieresTransport: decimal('indemnites_regulieres_transport', { precision: 15, scale: 2 }).default('0'),
  indemnitesRegulieresLogement: decimal('indemnites_regulieres_logement', { precision: 15, scale: 2 }).default('0'),
  indemnitesRegulieresAutres: decimal('indemnites_regulieres_autres', { precision: 15, scale: 2 }).default('0'),
  avantagesNatureLogement: decimal('avantages_nature_logement', { precision: 15, scale: 2 }).default('0'),
  avantagesNatureVehicule: decimal('avantages_nature_vehicule', { precision: 15, scale: 2 }).default('0'),
  avantagesNatureAutres: decimal('avantages_nature_autres', { precision: 15, scale: 2 }).default('0'),
  documentsCNI: text('documents_cni'),
  documentsContrat: text('documents_contrat'),
  documentsCV: text('documents_cv'),
  documentsAutres: text('documents_autres'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const avancesSalaire = pgTable('avances_salaire', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  employeId: integer('employe_id').references(() => employes.id).notNull(),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  dateAvance: date('date_avance').notNull(),
  montantRembourse: decimal('montant_rembourse', { precision: 15, scale: 2 }).default('0'),
  statut: varchar('statut', { length: 50 }).default('en_cours'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Fiches de paie (bulletins de salaire)
export const fichesPaie = pgTable('fiches_paie', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  employeId: integer('employe_id').references(() => employes.id).notNull(),
  mois: varchar('mois', { length: 7 }).notNull(),
  salaireBase: decimal('salaire_base', { precision: 15, scale: 2 }).notNull(),
  indemnitesTransport: decimal('indemnites_transport', { precision: 15, scale: 2 }).default('0'),
  indemnitesLogement: decimal('indemnites_logement', { precision: 15, scale: 2 }).default('0'),
  indemnitesAutres: decimal('indemnites_autres', { precision: 15, scale: 2 }).default('0'),
  avantagesNature: decimal('avantages_nature', { precision: 15, scale: 2 }).default('0'),
  heuresSupplementaires: decimal('heures_supplementaires', { precision: 15, scale: 2 }).default('0'),
  primes: decimal('primes', { precision: 15, scale: 2 }).default('0'),
  salaireBrut: decimal('salaire_brut', { precision: 15, scale: 2 }).notNull(),
  cotisationsCNPS: decimal('cotisations_cnps', { precision: 15, scale: 2 }).default('0'),
  cotisationsIPRES: decimal('cotisations_ipres', { precision: 15, scale: 2 }).default('0'),
  impotSurRevenu: decimal('impot_sur_revenu', { precision: 15, scale: 2 }).default('0'),
  autresRetenues: decimal('autres_retenues', { precision: 15, scale: 2 }).default('0'),
  avancesSalaire: decimal('avances_salaire', { precision: 15, scale: 2 }).default('0'),
  salaireNet: decimal('salaire_net', { precision: 15, scale: 2 }).notNull(),
  ecritureComptableId: integer('ecriture_comptable_id').references(() => ecritures.id),
  statut: varchar('statut', { length: 50 }).default('brouillon'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE 13: AUDIT LOG & PARAMETRES
// ==========================================

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  userId: integer('user_id').references(() => users.id),
  action: varchar('action', { length: 50 }).notNull(),
  tableName: varchar('table_name', { length: 100 }).notNull(),
  recordId: integer('record_id'),
  ancienneValeur: text('ancienne_valeur'),
  nouvelleValeur: text('nouvelle_valeur'),
  description: text('description'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 13B: PARAMETRES FISCAUX
// ==========================================

export const parametresFiscaux = pgTable('parametres_fiscaux', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  pays: varchar('pays', { length: 50 }).notNull(), // benin, senegal, cotedivoire, togo, mali, burkina
  administrationNom: varchar('administration_nom', { length: 255 }), // e-Tax, SIGTAS, e-Impôts, OTR, DGI
  numeroIFU: varchar('numero_ifu', { length: 100 }), // Identifiant Fiscal Unique
  numeroNIF: varchar('numero_nif', { length: 100 }), // Numéro d'Identification Fiscale
  centreImpots: varchar('centre_impots', { length: 255 }),
  regimeImposition: varchar('regime_imposition', { length: 100 }), // reel-normal, reel-simplifie, micro
  apiUrl: varchar('api_url', { length: 500 }), // URL base de l'API fiscale
  apiIdentifiant: varchar('api_identifiant', { length: 255 }), // Identifiant API
  apiCleSecrete: text('api_cle_secrete'), // Clé API cryptée
  connexionActive: boolean('connexion_active').default(false),
  derniereConnexion: timestamp('derniere_connexion'),
  derniereSynchronisation: timestamp('derniere_synchronisation'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Historique des déclarations fiscales
export const declarationsFiscales = pgTable('declarations_fiscales', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // tva, is, ir, autre
  periode: varchar('periode', { length: 50 }).notNull(), // 2024-01, 2024-Q1, 2024
  montant: decimal('montant', { precision: 15, scale: 2 }),
  statut: varchar('statut', { length: 50 }).default('brouillon'), // brouillon, soumise, acceptee, rejetee, payée
  numeroDeclaration: varchar('numero_declaration', { length: 255 }),
  dateDeclaration: date('date_declaration'),
  dateSoumission: timestamp('date_soumission'),
  datePaiement: timestamp('date_paiement'),
  referencePaiement: varchar('reference_paiement', { length: 255 }),
  reponseAdministration: text('reponse_administration'), // JSON de la réponse API
  erreurs: text('erreurs'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE 14: ORION SECURE - AUTHENTICATION & SECURITY
// ==========================================

// Permissions par rôle et module
export const permissions = pgTable('permissions', {
  id: serial('id').primaryKey(),
  role: userRoleEnum('role').notNull(), // admin, manager, accountant, employee, viewer
  module: varchar('module', { length: 100 }).notNull(), // clients, fournisseurs, stock, comptabilite, etc.
  action: varchar('action', { length: 50 }).notNull(), // create, read, update, delete, export
  autorise: boolean('autorise').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Sessions utilisateur actives
export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  enterpriseId: integer('enterprise_id').references(() => entreprises.id).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  refreshTokenHash: varchar('refresh_token_hash', { length: 255 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  logoutAt: timestamp('logout_at'),
});

// Audit des connexions
export const auditConnexions = pgTable('audit_connexions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  enterpriseId: integer('enterprise_id').references(() => entreprises.id).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // login, logout, failed_login, token_refresh
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  userAgent: text('user_agent'),
  statut: varchar('statut', { length: 50 }).default('success'), // success, failed
  raison: text('raison'), // raison de l'échec si statut=failed
  createdAt: timestamp('created_at').defaultNow(),
});

// Jetons de récupération de mot de passe
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 15: ORION ASSETS - IMMOBILISATIONS
// ==========================================

// Catégories d'immobilisations avec durée de vie et méthode
export const categoriesImmobilisations = pgTable('categories_immobilisations', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(), // Bâtiments, Véhicules, Matériel, etc.
  dureeVie: integer('duree_vie').notNull(), // en années
  methodeAmortissement: varchar('methode_amortissement', { length: 50 }).notNull(), // linéaire, dégressif
  compteAmortissement: varchar('compte_amortissement', { length: 100 }), // numéro compte comptable
  compte: varchar('compte', { length: 100 }), // compte principal
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Registre immobilisations
export const immobilisations = pgTable('immobilisations', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  reference: varchar('reference', { length: 100 }).unique(),
  description: text('description'),
  categorieId: integer('categorie_id').references(() => categoriesImmobilisations.id).notNull(),
  dateAcquisition: date('date_acquisition').notNull(),
  valeurAcquisition: decimal('valeur_acquisition', { precision: 15, scale: 2 }).notNull(),
  amortissementCumule: decimal('amortissement_cumule', { precision: 15, scale: 2 }).default('0'),
  valeurNetteComptable: decimal('valeur_nette_comptable', { precision: 15, scale: 2 }).notNull(),
  statut: varchar('statut', { length: 50 }).default('actif'), // actif, cédée, amortie
  dateCession: date('date_cession'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Amortissements mensuels
export const amortissements = pgTable('amortissements', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  immobilisationId: integer('immobilisation_id').references(() => immobilisations.id).notNull(),
  dateAmortissement: date('date_amortissement').notNull(),
  montant: decimal('montant', { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Cessions/sorties d'immobilisations
export const cessionsImmobilisations = pgTable('cessions_immobilisations', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  immobilisationId: integer('immobilisation_id').references(() => immobilisations.id).notNull(),
  dateCession: date('date_cession').notNull(),
  valeurNetteComptable: decimal('valeur_nette_comptable', { precision: 15, scale: 2 }).notNull(),
  prixVente: decimal('prix_vente', { precision: 15, scale: 2 }).notNull(),
  gainPerte: decimal('gain_perte', { precision: 15, scale: 2 }).notNull(),
  comptabilisee: boolean('comptabilisee').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// RELATIONS
// ==========================================

export const entreprisesRelations = relations(entreprises, ({ many }) => ({
  users: many(users),
  clients: many(clients),
  fournisseurs: many(fournisseurs),
  produits: many(produits),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [users.entrepriseId],
    references: [entreprises.id],
  }),
  commandes: many(commandes),
  factures: many(factures),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [clients.entrepriseId],
    references: [entreprises.id],
  }),
  compteComptable: one(comptesComptables, {
    fields: [clients.compteComptableId],
    references: [comptesComptables.id],
  }),
  commandes: many(commandes),
  factures: many(factures),
}));

export const fournisseursRelations = relations(fournisseurs, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [fournisseurs.entrepriseId],
    references: [entreprises.id],
  }),
  produits: many(produits),
}));

export const produitsRelations = relations(produits, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [produits.entrepriseId],
    references: [entreprises.id],
  }),
  fournisseur: one(fournisseurs, {
    fields: [produits.fournisseurId],
    references: [fournisseurs.id],
  }),
  mouvements: many(mouvementsStock),
}));

export const commandesRelations = relations(commandes, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [commandes.entrepriseId],
    references: [entreprises.id],
  }),
  client: one(clients, {
    fields: [commandes.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [commandes.userId],
    references: [users.id],
  }),
  items: many(commandeItems),
  facture: many(factures),
}));

export const facturesRelations = relations(factures, ({ one, many }) => ({
  entreprise: one(entreprises, {
    fields: [factures.entrepriseId],
    references: [entreprises.id],
  }),
  client: one(clients, {
    fields: [factures.clientId],
    references: [clients.id],
  }),
  commande: one(commandes, {
    fields: [factures.commandeId],
    references: [commandes.id],
  }),
  items: many(factureItems),
  paiements: many(paiements),
}));

// ==========================================
// MODULE COMPTABILITÉ GÉNÉRALE
// ==========================================

// Plans comptables
export const plansComptables = pgTable('plans_comptables', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  systeme: varchar('systeme', { length: 50 }), // SYSCOHADA, IFRS, PCG
  description: text('description'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Comptes comptables
export const comptes = pgTable('comptes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  numero: varchar('numero', { length: 50 }).notNull(), // 601, 411, 512, etc.
  nom: varchar('nom', { length: 255 }).notNull(),
  categorie: varchar('categorie', { length: 100 }), // Actif, Passif, Capitaux propres, Charges, Produits
  sousCategorie: varchar('sous_categorie', { length: 100 }),
  devise: varchar('devise', { length: 10 }).default('XOF'),
  solde: decimal('solde', { precision: 15, scale: 2 }).default('0'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Journaux comptables
export const journaux = pgTable('journaux', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  code: varchar('code', { length: 20 }).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }), // Achats, Ventes, Banque, Caisse, OD
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Écritures comptables
export const ecritures = pgTable('ecritures', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  journalId: integer('journal_id').references(() => journaux.id).notNull(),
  numeroEcriture: varchar('numero_ecriture', { length: 100 }),
  dateEcriture: date('date_ecriture').notNull(),
  libelle: text('libelle'),
  numeroPiece: varchar('numero_piece', { length: 100 }),
  valide: boolean('valide').default(false),
  userId: integer('user_id'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Lignes d'écritures (débit/crédit)
export const lignesEcritures = pgTable('lignes_ecriture', {
  id: serial('id').primaryKey(),
  ecritureId: integer('ecriture_id').references(() => ecritures.id).notNull(),
  compteComptableId: integer('compte_comptable_id').references(() => comptesComptables.id).notNull(),
  debit: decimal('debit', { precision: 15, scale: 2 }).default('0'),
  credit: decimal('credit', { precision: 15, scale: 2 }).default('0'),
  libelle: text('libelle'),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id),
});

// Soldes comptables (cache)
export const soldesComptes = pgTable('soldes_comptes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  compteId: integer('compte_id').references(() => comptes.id).notNull(),
  periode: varchar('periode', { length: 10 }), // YYYY-MM
  soldeDebit: decimal('solde_debit', { precision: 15, scale: 2 }).default('0'),
  soldeCredit: decimal('solde_credit', { precision: 15, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Écritures récurrentes (modèles)
export const ecrituresRecurrentes = pgTable('ecritures_recurrentes', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  journalId: integer('journal_id').references(() => journaux.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  description: text('description'),
  frequence: varchar('frequence', { length: 50 }).notNull(), // mensuel, trimestriel, semestriel, annuel
  jourDuMois: integer('jour_du_mois').default(1), // 1-31
  moisDebut: integer('mois_debut').default(1), // 1-12 (pour annuel/semestriel)
  dateDebut: date('date_debut').notNull(),
  dateFin: date('date_fin'),
  derniereDateGeneration: date('derniere_date_generation'),
  prochaineDateGeneration: date('prochaine_date_generation'),
  montantReference: decimal('montant_reference', { precision: 15, scale: 2 }),
  lignesModele: jsonb('lignes_modele'), // [{compteId, montant, type, description}]
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Historique de génération des écritures récurrentes
export const histoGeneration = pgTable('histo_generation', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  ecritureRecurrenteId: integer('ecriture_recurrente_id').references(() => ecrituresRecurrentes.id).notNull(),
  ecritureId: integer('ecriture_id').references(() => ecritures.id),
  dateGeneration: timestamp('date_generation').defaultNow(),
  dateEcriture: date('date_ecriture').notNull(),
  statut: varchar('statut', { length: 50 }).default('generee'), // generee, echouee
  messageErreur: text('message_erreur'),
});

// Paramètres comptables avancés
export const parametresComptables = pgTable('parametres_comptables', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull().unique(),
  
  // Numérotation automatique
  prefixeEcritures: varchar('prefixe_ecritures', { length: 10 }).default('EC'),
  numeroSuivantEcriture: integer('numero_suivant_ecriture').default(1),
  formatNumeroEcriture: varchar('format_numero_ecriture', { length: 50 }).default('[PREFIX]-[YEAR]-[NUM]'),
  
  // Validation et contrôle
  validationAutomatique: boolean('validation_automatique').default(false),
  toleranceDesequilibre: decimal('tolerance_desequilibre', { precision: 10, scale: 2 }).default('0.01'),
  bloquerSiDesequilibre: boolean('bloquer_si_desequilibre').default(true),
  
  // Exercice comptable
  clotureDateLimite: date('cloture_date_limite'),
  exerciceCourant: varchar('exercice_courant', { length: 10 }),
  
  // Options d'affichage
  afficherSoldesComptes: boolean('afficher_soldes_comptes').default(true),
  afficherCodeComplet: boolean('afficher_code_complet').default(true),
  
  // Archivage
  archiverApresNJours: integer('archiver_apres_n_jours').default(365),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE ABONNEMENTS & FACTURATION
// ==========================================

// Plans d'abonnement
export const plansAbonnement = pgTable('plans_abonnement', {
  id: serial('id').primaryKey(),
  nom: varchar('nom', { length: 255 }).notNull(), // Gratuit, Pro, Entreprise
  prix: decimal('prix', { precision: 10, scale: 2 }).notNull(),
  devise: varchar('devise', { length: 10 }).default('EUR'),
  periode: varchar('periode', { length: 50 }).default('mensuel'), // mensuel, annuel
  limiteUtilisateurs: integer('limite_utilisateurs').default(5),
  limiteEntreprises: integer('limite_entreprises').default(1),
  stockageGb: integer('stockage_gb').default(10),
  supportEmail: boolean('support_email').default(true),
  supportPrioritaire: boolean('support_prioritaire').default(false),
  featuresCRM: boolean('features_crm').default(true),
  featuresRH: boolean('features_rh').default(false),
  featuresComptabilite: boolean('features_comptabilite').default(true),
  descriptionFeatures: text('description_features'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// Abonnements actifs
export const abonnements = pgTable('abonnements', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull().unique(),
  planId: integer('plan_id').references(() => plansAbonnement.id).notNull(),
  statut: varchar('statut', { length: 50 }).default('actif'), // actif, suspendu, expire, annule
  dateDebut: date('date_debut').notNull(),
  dateExpiration: date('date_expiration').notNull(),
  prochainRenouvellement: date('prochain_renouvellement'),
  nombreUtilisateurs: integer('nombre_utilisateurs').default(1),
  montantMensuel: decimal('montant_mensuel', { precision: 10, scale: 2 }).notNull(),
  modeRenouvellement: varchar('mode_renouvellement', { length: 50 }).default('automatique'), // automatique, manuel
  remarques: text('remarques'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Historique des factures d'abonnement
export const facturesAbonnement = pgTable('factures_abonnement', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  abonnementId: integer('abonnement_id').references(() => abonnements.id).notNull(),
  numerofacture: varchar('numero_facture', { length: 100 }).unique(),
  montant: decimal('montant', { precision: 10, scale: 2 }).notNull(),
  devise: varchar('devise', { length: 10 }).default('EUR'),
  dateFacture: date('date_facture').notNull(),
  datePaiement: date('date_paiement'),
  statut: varchar('statut', { length: 50 }).default('en_attente'), // en_attente, payee, echouee
  methodePaiement: varchar('methode_paiement', { length: 100 }), // carte_credit, virement, etc
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE 17: SAAS ADMIN - COMMERCIALISATION
// ==========================================

// Commerciaux/Vendeurs
export const saasCommerciaux = pgTable('saas_commerciaux', {
  id: serial('id').primaryKey(),
  nom: varchar('nom', { length: 255 }).notNull(),
  prenom: varchar('prenom', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  telephone: varchar('telephone', { length: 50 }),
  passwordHash: varchar('password_hash', { length: 255 }), // Pour authentification espace commercial
  region: varchar('region', { length: 100 }), // Afrique de l'Ouest, Centrale, etc.
  commission: decimal('commission', { precision: 5, scale: 2 }).default('10'), // % de commission - modifiable par admin uniquement
  objectifMensuel: decimal('objectif_mensuel', { precision: 15, scale: 2 }),
  nbClientsActifs: integer('nb_clients_actifs').default(0),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Clients SaaS (organisations qui utilisent ComptaOrion - extension de entreprises)
export const saasClients = pgTable('saas_clients', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).unique(), // lien vers entreprise
  commercialId: integer('commercial_id').references(() => saasCommerciaux.id),
  statut: varchar('statut', { length: 50 }).default('trial'), // trial, actif, suspendu, inactif
  dateInscription: timestamp('date_inscription').defaultNow(),
  dateDerniereConnexion: timestamp('date_derniere_connexion'),
  source: varchar('source', { length: 100 }), // web, commercial, partenaire
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Ventes (tracking des ventes par commercial)
export const saasVentes = pgTable('saas_ventes', {
  id: serial('id').primaryKey(),
  commercialId: integer('commercial_id').references(() => saasCommerciaux.id), // Nullable pour ventes web
  clientId: integer('client_id').references(() => saasClients.id).notNull(),
  abonnementId: integer('abonnement_id').references(() => abonnements.id),
  montantVente: decimal('montant_vente', { precision: 15, scale: 2 }).notNull(),
  commission: decimal('commission', { precision: 15, scale: 2 }).default('0'), // 0 pour ventes web
  dateVente: timestamp('date_vente').defaultNow(),
  statut: varchar('statut', { length: 50 }).default('confirmée'), // confirmée, annulée
  source: varchar('source', { length: 50 }).default('commercial'), // commercial, web, api
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE EMAILS: HISTORIQUE D'ENVOI
// ==========================================

export const historiqueEmails = pgTable('historique_emails', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  factureId: integer('facture_id').references(() => factures.id),
  destinataire: varchar('destinataire', { length: 255 }).notNull(),
  sujet: varchar('sujet', { length: 500 }).notNull(),
  typeEmail: varchar('type_email', { length: 50 }).default('facture'), // facture, devis, relance, etc.
  statut: emailStatusEnum('statut').default('en_attente'),
  messageErreur: text('message_erreur'),
  dateEnvoi: timestamp('date_envoi').defaultNow(),
  envoyePar: integer('envoye_par').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// INSCRIPTIONS EN ATTENTE (FedaPay)
// ==========================================
// Table pour persister les inscriptions en attente et lier transaction_id à l'intention
export const inscriptionsEnAttente = pgTable('inscriptions_en_attente', {
  id: serial('id').primaryKey(),
  transactionId: varchar('transaction_id', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  nomEntreprise: varchar('nom_entreprise', { length: 255 }).notNull(),
  telephone: varchar('telephone', { length: 50 }),
  pays: varchar('pays', { length: 100 }),
  planId: integer('plan_id').notNull(),
  dureeEnMois: integer('duree_en_mois').notNull(),
  montantTotal: decimal('montant_total', { precision: 15, scale: 2 }).notNull(),
  methodePaiement: varchar('methode_paiement', { length: 50 }), // fedapay, stripe, paypal
  typeInscription: varchar('type_inscription', { length: 50 }).notNull(), // 'nouveau' ou 'renouvellement'
  entrepriseIdPourRenouvellement: integer('entreprise_id_pour_renouvellement'), // Si renouvellement
  commercialId: integer('commercial_id'), // ID du commercial référent (lien parrainage)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  traitee: boolean('traitee').default(false).notNull()
});

// ==========================================
// MODULE INTEGRATIONS: API, WEBHOOKS, BACKUPS
// ==========================================

// Clés API pour accès externe
export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  keyHash: varchar('key_hash', { length: 255 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
  permissions: jsonb('permissions').default('["read"]'),
  ipAllowlist: jsonb('ip_allowlist'),
  lastUsedAt: timestamp('last_used_at'),
  expiresAt: timestamp('expires_at'),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
});

// Abonnements aux webhooks
export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  url: text('url').notNull(),
  secret: varchar('secret', { length: 255 }).notNull(),
  evenements: jsonb('evenements').default('[]'),
  actif: boolean('actif').default(true),
  lastDeliveryAt: timestamp('last_delivery_at'),
  lastDeliveryStatus: varchar('last_delivery_status', { length: 50 }),
  failureCount: integer('failure_count').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Historique des livraisons de webhooks
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: serial('id').primaryKey(),
  subscriptionId: integer('subscription_id').references(() => webhookSubscriptions.id).notNull(),
  evenement: varchar('evenement', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  durationMs: integer('duration_ms'),
  tentative: integer('tentative').default(1),
  statut: varchar('statut', { length: 50 }).default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Configuration des sauvegardes programmées
export const backupConfigs = pgTable('backup_configs', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  nom: varchar('nom', { length: 255 }).notNull(),
  destination: varchar('destination', { length: 50 }).notNull(),
  configDestination: jsonb('config_destination').notNull(),
  format: varchar('format', { length: 20 }).default('json'),
  frequence: varchar('frequence', { length: 50 }).default('weekly'),
  heureExecution: varchar('heure_execution', { length: 10 }).default('02:00'),
  domainesInclus: jsonb('domaines_inclus').default('["all"]'),
  chiffrement: boolean('chiffrement').default(true),
  actif: boolean('actif').default(true),
  dernierBackup: timestamp('dernier_backup'),
  prochainBackup: timestamp('prochain_backup'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Historique des jobs de backup
export const backupJobs = pgTable('backup_jobs', {
  id: serial('id').primaryKey(),
  configId: integer('config_id').references(() => backupConfigs.id),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  type: varchar('type', { length: 50 }).default('scheduled'),
  format: varchar('format', { length: 20 }).notNull(),
  domainesExportes: jsonb('domaines_exportes').notNull(),
  tailleFichier: integer('taille_fichier'),
  checksum: varchar('checksum', { length: 64 }),
  destination: varchar('destination', { length: 50 }),
  urlTelechargement: text('url_telechargement'),
  expirationUrl: timestamp('expiration_url'),
  statut: varchar('statut', { length: 50 }).default('pending'),
  messageErreur: text('message_erreur'),
  demarreAt: timestamp('demarre_at'),
  termineAt: timestamp('termine_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Historique des exports manuels
export const exportHistory = pgTable('export_history', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  userId: integer('user_id').references(() => users.id).notNull(),
  domaine: varchar('domaine', { length: 100 }).notNull(),
  format: varchar('format', { length: 20 }).notNull(),
  filtres: jsonb('filtres'),
  nombreEnregistrements: integer('nombre_enregistrements'),
  tailleFichier: integer('taille_fichier'),
  ipAddress: varchar('ip_address', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow(),
});

// ==========================================
// MODULE: IMPORT DE DONNÉES EXTERNES
// ==========================================

// Statut des imports: brouillon, en_cours, validation, termine, echec
export const importStatusEnum = pgEnum('import_status', ['brouillon', 'en_cours', 'validation', 'termine', 'echec']);

// Batch d'import (une session d'import complète)
export const importBatches = pgTable('import_batches', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  userId: integer('user_id').references(() => users.id).notNull(),
  
  // Source et format
  sourceLogiciel: varchar('source_logiciel', { length: 100 }).notNull(), // quickbooks, sage100, excel, csv
  formatFichier: varchar('format_fichier', { length: 50 }).notNull(), // csv, xlsx, iif, xml
  nomFichier: varchar('nom_fichier', { length: 255 }),
  tailleFichier: integer('taille_fichier'),
  
  // Type de données importées
  typeEntite: varchar('type_entite', { length: 100 }).notNull(), // clients, fournisseurs, plan_comptable, factures, ecritures, etc.
  
  // Configuration de mapping
  mappingColonnes: jsonb('mapping_colonnes'), // { colonneFichier: champDestination }
  optionsImport: jsonb('options_import'), // { ignoreDoublons: true, mettreAJour: false, etc. }
  
  // Statistiques
  nombreLignesTotal: integer('nombre_lignes_total').default(0),
  nombreLignesValides: integer('nombre_lignes_valides').default(0),
  nombreLignesErreurs: integer('nombre_lignes_erreurs').default(0),
  nombreLignesImportees: integer('nombre_lignes_importees').default(0),
  
  // Statut
  statut: varchar('statut', { length: 50 }).default('brouillon'),
  messageErreur: text('message_erreur'),
  
  // Timestamps
  demarreAt: timestamp('demarre_at'),
  termineAt: timestamp('termine_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Enregistrements individuels en staging avant commit
export const importRecords = pgTable('import_records', {
  id: serial('id').primaryKey(),
  batchId: integer('batch_id').references(() => importBatches.id).notNull(),
  
  // Numéro de ligne dans le fichier source
  ligneFichier: integer('ligne_fichier').notNull(),
  
  // Données brutes du fichier
  donneesOriginales: jsonb('donnees_originales').notNull(),
  
  // Données transformées prêtes pour import
  donneesTransformees: jsonb('donnees_transformees'),
  
  // Identifiant externe (pour éviter doublons)
  identifiantExterne: varchar('identifiant_externe', { length: 255 }),
  
  // Validation
  estValide: boolean('est_valide').default(false),
  erreursValidation: jsonb('erreurs_validation'), // [{ champ: 'email', message: 'Format invalide' }]
  avertissements: jsonb('avertissements'),
  
  // Après import réussi
  entiteCreeeId: integer('entite_creee_id'),
  entiteCreeeType: varchar('entite_creee_type', { length: 100 }),
  
  // Statut
  statut: varchar('statut', { length: 50 }).default('en_attente'), // en_attente, valide, erreur, importe, ignore
  
  createdAt: timestamp('created_at').defaultNow(),
});

// Templates de mapping pour différents logiciels sources
export const importMappingTemplates = pgTable('import_mapping_templates', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id),
  
  // Identification du template
  nom: varchar('nom', { length: 255 }).notNull(),
  sourceLogiciel: varchar('source_logiciel', { length: 100 }).notNull(),
  typeEntite: varchar('type_entite', { length: 100 }).notNull(),
  
  // Configuration de mapping
  mappingColonnes: jsonb('mapping_colonnes').notNull(),
  transformations: jsonb('transformations'), // Règles de transformation des données
  validationsPersonnalisees: jsonb('validations_personnalisees'),
  
  // Mapping spécifique pour plan comptable (SYSCOHADA)
  mappingComptes: jsonb('mapping_comptes'), // { compteSource: compteDestinationSYSCOHADA }
  
  // Template système ou personnalisé
  estSysteme: boolean('est_systeme').default(false),
  actif: boolean('actif').default(true),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE: TABLE DE PRIX PRODUITS (Marge Brute)
// ==========================================

export const produitPrix = pgTable('produit_prix', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  produitId: integer('produit_id').references(() => produits.id).notNull(),
  
  // Prix et coûts
  coutAchat: decimal('cout_achat', { precision: 15, scale: 2 }).notNull(),
  margeBruteCible: decimal('marge_brute_cible', { precision: 5, scale: 2 }).notNull(), // En pourcentage (ex: 30 pour 30%)
  prixVenteCalcule: decimal('prix_vente_calcule', { precision: 15, scale: 2 }).notNull(),
  prixVenteManuel: decimal('prix_vente_manuel', { precision: 15, scale: 2 }), // Surcharge manuelle optionnelle
  
  // Catégorie client (prix différenciés)
  categorieClient: varchar('categorie_client', { length: 100 }).default('standard'),
  
  // Canal de vente
  canalVente: varchar('canal_vente', { length: 100 }).default('tous'), // tous, boutique, en_ligne, grossiste
  
  // Dates de validité
  dateEffet: date('date_effet').defaultNow(),
  dateExpiration: date('date_expiration'),
  
  // Devise
  devise: varchar('devise', { length: 10 }).default('FCFA'),
  
  // Statut
  actif: boolean('actif').default(true),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ==========================================
// MODULE: TAUX DE CHANGE (Multi-devises)
// ==========================================

export const tauxChange = pgTable('taux_change', {
  id: serial('id').primaryKey(),
  entrepriseId: integer('entreprise_id').references(() => entreprises.id).notNull(),
  
  // Paire de devises (ex: EUR/USD, USD/XOF, EUR/XOF)
  deviseSource: varchar('devise_source', { length: 10 }).notNull(), // Devise de départ
  deviseCible: varchar('devise_cible', { length: 10 }).notNull(), // Devise d'arrivée (flexible, pas fixe)
  
  // Taux et date (1 deviseSource = X deviseCible)
  taux: decimal('taux', { precision: 18, scale: 6 }).notNull(),
  dateEffet: date('date_effet').notNull(),
  
  // Source du taux
  source: varchar('source', { length: 50 }).default('manuel'), // manuel, bceao, ecb, etc.
  
  // Métadonnées
  notes: text('notes'),
  createdBy: integer('created_by').references(() => users.id),
  
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Liste des devises supportées
export const devises = pgTable('devises', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 10 }).notNull().unique(), // EUR, USD, XOF, etc.
  nom: varchar('nom', { length: 100 }).notNull(), // Euro, Dollar US, Franc CFA, etc.
  symbole: varchar('symbole', { length: 10 }).notNull(), // €, $, FCFA, etc.
  decimales: integer('decimales').default(2),
  actif: boolean('actif').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});
