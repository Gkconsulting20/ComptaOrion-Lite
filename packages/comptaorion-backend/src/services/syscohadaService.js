import { db } from '../db.js';
import { comptesComptables, journaux } from '../schema.js';
import { eq } from 'drizzle-orm';

const PLAN_SYSCOHADA = [
  // Classe 1 - Comptes de ressources durables
  { numero: '101', nom: 'Capital social', categorie: 'Capitaux propres', classe: '1' },
  { numero: '106', nom: 'Réserves', categorie: 'Capitaux propres', classe: '1' },
  { numero: '109', nom: 'Actionnaires, capital souscrit non appelé', categorie: 'Capitaux propres', classe: '1' },
  { numero: '110', nom: 'Report à nouveau', categorie: 'Capitaux propres', classe: '1' },
  { numero: '120', nom: 'Résultat de l\'exercice (bénéfice)', categorie: 'Capitaux propres', classe: '1' },
  { numero: '129', nom: 'Résultat de l\'exercice (perte)', categorie: 'Capitaux propres', classe: '1' },
  { numero: '130', nom: 'Résultat en instance d\'affectation', categorie: 'Capitaux propres', classe: '1' },
  { numero: '140', nom: 'Subventions d\'investissement', categorie: 'Capitaux propres', classe: '1' },
  { numero: '160', nom: 'Emprunts et dettes assimilées', categorie: 'Passif', classe: '1' },
  { numero: '161', nom: 'Emprunts obligataires', categorie: 'Passif', classe: '1' },
  { numero: '162', nom: 'Emprunts auprès des établissements de crédit', categorie: 'Passif', classe: '1' },
  { numero: '165', nom: 'Dépôts et cautionnements reçus', categorie: 'Passif', classe: '1' },
  { numero: '170', nom: 'Dettes de crédit-bail et contrats assimilés', categorie: 'Passif', classe: '1' },
  { numero: '180', nom: 'Dettes liées à des participations', categorie: 'Passif', classe: '1' },
  { numero: '190', nom: 'Provisions financières pour risques et charges', categorie: 'Passif', classe: '1' },
  
  // Classe 2 - Comptes d'actif immobilisé
  { numero: '201', nom: 'Frais d\'établissement', categorie: 'Actif', classe: '2' },
  { numero: '211', nom: 'Terrains', categorie: 'Actif', classe: '2' },
  { numero: '212', nom: 'Agencements et aménagements de terrains', categorie: 'Actif', classe: '2' },
  { numero: '213', nom: 'Constructions', categorie: 'Actif', classe: '2' },
  { numero: '215', nom: 'Installations techniques', categorie: 'Actif', classe: '2' },
  { numero: '218', nom: 'Autres immobilisations corporelles', categorie: 'Actif', classe: '2' },
  { numero: '221', nom: 'Brevets, licences, logiciels', categorie: 'Actif', classe: '2' },
  { numero: '231', nom: 'Immobilisations corporelles en cours', categorie: 'Actif', classe: '2' },
  { numero: '241', nom: 'Matériel de transport', categorie: 'Actif', classe: '2' },
  { numero: '244', nom: 'Mobilier et matériel de bureau', categorie: 'Actif', classe: '2' },
  { numero: '245', nom: 'Matériel informatique', categorie: 'Actif', classe: '2' },
  { numero: '260', nom: 'Participations et créances rattachées', categorie: 'Actif', classe: '2' },
  { numero: '270', nom: 'Autres immobilisations financières', categorie: 'Actif', classe: '2' },
  { numero: '280', nom: 'Amortissements des immobilisations', categorie: 'Actif', classe: '2' },
  { numero: '290', nom: 'Provisions pour dépréciation', categorie: 'Actif', classe: '2' },
  
  // Classe 3 - Comptes de stocks
  { numero: '310', nom: 'Marchandises', categorie: 'Actif', classe: '3' },
  { numero: '311', nom: 'Marchandises A', categorie: 'Actif', classe: '3' },
  { numero: '312', nom: 'Marchandises B', categorie: 'Actif', classe: '3' },
  { numero: '320', nom: 'Matières premières et fournitures liées', categorie: 'Actif', classe: '3' },
  { numero: '330', nom: 'Autres approvisionnements', categorie: 'Actif', classe: '3' },
  { numero: '340', nom: 'Produits en cours', categorie: 'Actif', classe: '3' },
  { numero: '350', nom: 'Services en cours', categorie: 'Actif', classe: '3' },
  { numero: '360', nom: 'Produits finis', categorie: 'Actif', classe: '3' },
  { numero: '370', nom: 'Produits intermédiaires', categorie: 'Actif', classe: '3' },
  { numero: '380', nom: 'Stocks à l\'extérieur', categorie: 'Actif', classe: '3' },
  { numero: '390', nom: 'Dépréciations des stocks', categorie: 'Actif', classe: '3' },
  
  // Classe 4 - Comptes de tiers
  { numero: '40', nom: 'Fournisseurs et comptes rattachés (compte principal)', categorie: 'Passif', classe: '4' },
  { numero: '401', nom: 'Fournisseurs', categorie: 'Passif', classe: '4' },
  { numero: '4011', nom: 'Fournisseurs - Achats de biens', categorie: 'Passif', classe: '4' },
  { numero: '4012', nom: 'Fournisseurs - Achats de services', categorie: 'Passif', classe: '4' },
  { numero: '408', nom: 'Fournisseurs - Factures non parvenues', categorie: 'Passif', classe: '4' },
  { numero: '409', nom: 'Fournisseurs débiteurs', categorie: 'Actif', classe: '4' },
  { numero: '411', nom: 'Clients', categorie: 'Actif', classe: '4' },
  { numero: '4111', nom: 'Clients - Ventes de biens', categorie: 'Actif', classe: '4' },
  { numero: '4112', nom: 'Clients - Ventes de services', categorie: 'Actif', classe: '4' },
  { numero: '412', nom: 'Clients - Effets à recevoir', categorie: 'Actif', classe: '4' },
  { numero: '416', nom: 'Clients douteux ou litigieux', categorie: 'Actif', classe: '4' },
  { numero: '418', nom: 'Clients - Produits non encore facturés', categorie: 'Actif', classe: '4' },
  { numero: '419', nom: 'Clients créditeurs', categorie: 'Passif', classe: '4' },
  { numero: '42', nom: 'Personnel (compte principal)', categorie: 'Passif', classe: '4' },
  { numero: '421', nom: 'Personnel - Rémunérations dues', categorie: 'Passif', classe: '4' },
  { numero: '422', nom: 'Personnel - Avances et acomptes', categorie: 'Actif', classe: '4' },
  { numero: '423', nom: 'Personnel - Oppositions', categorie: 'Passif', classe: '4' },
  { numero: '424', nom: 'Personnel - Participation au résultat', categorie: 'Passif', classe: '4' },
  { numero: '425', nom: 'Personnel - Dépôts', categorie: 'Passif', classe: '4' },
  { numero: '428', nom: 'Personnel - Charges à payer', categorie: 'Passif', classe: '4' },
  { numero: '431', nom: 'Sécurité sociale', categorie: 'Passif', classe: '4' },
  { numero: '432', nom: 'Caisse de retraite', categorie: 'Passif', classe: '4' },
  { numero: '433', nom: 'Autres organismes sociaux', categorie: 'Passif', classe: '4' },
  { numero: '438', nom: 'Organismes sociaux - Charges à payer', categorie: 'Passif', classe: '4' },
  { numero: '44', nom: 'État et collectivités publiques (compte principal)', categorie: 'Passif', classe: '4' },
  { numero: '441', nom: 'État - Impôts sur les bénéfices', categorie: 'Passif', classe: '4' },
  { numero: '442', nom: 'État - Autres impôts et taxes', categorie: 'Passif', classe: '4' },
  { numero: '443', nom: 'État - TVA facturée', categorie: 'Passif', classe: '4' },
  { numero: '4431', nom: 'TVA facturée sur ventes', categorie: 'Passif', classe: '4' },
  { numero: '4432', nom: 'TVA facturée sur prestations', categorie: 'Passif', classe: '4' },
  { numero: '4434', nom: 'TVA due à l\'État', categorie: 'Passif', classe: '4' },
  { numero: '445', nom: 'État - TVA récupérable', categorie: 'Actif', classe: '4' },
  { numero: '4451', nom: 'TVA récupérable sur immobilisations', categorie: 'Actif', classe: '4' },
  { numero: '4452', nom: 'TVA récupérable sur achats', categorie: 'Actif', classe: '4' },
  { numero: '4453', nom: 'TVA récupérable sur services', categorie: 'Actif', classe: '4' },
  { numero: '447', nom: 'État - Impôts retenus à la source', categorie: 'Passif', classe: '4' },
  { numero: '4471', nom: 'Impôt sur salaires', categorie: 'Passif', classe: '4' },
  { numero: '4472', nom: 'Impôt sur revenus non salariaux', categorie: 'Passif', classe: '4' },
  { numero: '449', nom: 'État - Créances et dettes diverses', categorie: 'Passif', classe: '4' },
  { numero: '450', nom: 'Groupe', categorie: 'Actif', classe: '4' },
  { numero: '451', nom: 'Opérations groupe', categorie: 'Actif', classe: '4' },
  { numero: '455', nom: 'Associés - Comptes courants', categorie: 'Passif', classe: '4' },
  { numero: '456', nom: 'Associés - Opérations sur le capital', categorie: 'Actif', classe: '4' },
  { numero: '457', nom: 'Associés - Dividendes à payer', categorie: 'Passif', classe: '4' },
  { numero: '460', nom: 'Débiteurs divers', categorie: 'Actif', classe: '4' },
  { numero: '470', nom: 'Créditeurs divers', categorie: 'Passif', classe: '4' },
  { numero: '471', nom: 'Comptes d\'attente à régulariser', categorie: 'Actif', classe: '4' },
  { numero: '476', nom: 'Charges constatées d\'avance', categorie: 'Actif', classe: '4' },
  { numero: '477', nom: 'Produits constatés d\'avance', categorie: 'Passif', classe: '4' },
  { numero: '478', nom: 'Écarts de conversion - Passif', categorie: 'Passif', classe: '4' },
  { numero: '479', nom: 'Écarts de conversion - Actif', categorie: 'Actif', classe: '4' },
  { numero: '490', nom: 'Dépréciations des comptes de tiers', categorie: 'Actif', classe: '4' },
  { numero: '491', nom: 'Dépréciations des comptes clients', categorie: 'Actif', classe: '4' },
  
  // Classe 5 - Comptes de trésorerie
  { numero: '50', nom: 'Valeurs mobilières de placement (compte principal)', categorie: 'Actif', classe: '5' },
  { numero: '501', nom: 'Valeurs mobilières de placement', categorie: 'Actif', classe: '5' },
  { numero: '502', nom: 'Actions propres', categorie: 'Actif', classe: '5' },
  { numero: '506', nom: 'Obligations', categorie: 'Actif', classe: '5' },
  { numero: '51', nom: 'Banques, établissements financiers et assimilés', categorie: 'Actif', classe: '5' },
  { numero: '52', nom: 'Banques (compte principal)', categorie: 'Actif', classe: '5' },
  { numero: '512', nom: 'Banques', categorie: 'Actif', classe: '5' },
  { numero: '5121', nom: 'Banque principale', categorie: 'Actif', classe: '5' },
  { numero: '5122', nom: 'Banque secondaire', categorie: 'Actif', classe: '5' },
  { numero: '513', nom: 'Chèques à encaisser', categorie: 'Actif', classe: '5' },
  { numero: '514', nom: 'Chèques à l\'encaissement', categorie: 'Actif', classe: '5' },
  { numero: '515', nom: 'Caisse', categorie: 'Actif', classe: '5' },
  { numero: '516', nom: 'Trésor public', categorie: 'Actif', classe: '5' },
  { numero: '517', nom: 'Régies d\'avances et accréditifs', categorie: 'Actif', classe: '5' },
  { numero: '518', nom: 'Virements de fonds', categorie: 'Actif', classe: '5' },
  { numero: '520', nom: 'Banques, découverts', categorie: 'Passif', classe: '5' },
  { numero: '521', nom: 'Crédits de trésorerie', categorie: 'Passif', classe: '5' },
  { numero: '530', nom: 'Établissements financiers', categorie: 'Actif', classe: '5' },
  { numero: '56', nom: 'Banques, crédits de trésorerie (compte principal)', categorie: 'Passif', classe: '5' },
  { numero: '560', nom: 'Banques, crédits de trésorerie', categorie: 'Passif', classe: '5' },
  { numero: '57', nom: 'Caisse (compte principal)', categorie: 'Actif', classe: '5' },
  { numero: '570', nom: 'Caisses', categorie: 'Actif', classe: '5' },
  { numero: '5711', nom: 'Caisse principale', categorie: 'Actif', classe: '5' },
  { numero: '5712', nom: 'Caisse secondaire', categorie: 'Actif', classe: '5' },
  { numero: '580', nom: 'Virements internes', categorie: 'Actif', classe: '5' },
  { numero: '590', nom: 'Dépréciations des titres de placement', categorie: 'Actif', classe: '5' },
  
  // Classe 6 - Comptes de charges
  { numero: '60', nom: 'Achats (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '61', nom: 'Services extérieurs (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '62', nom: 'Autres services extérieurs (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '63', nom: 'Impôts et taxes (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '64', nom: 'Charges de personnel (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '65', nom: 'Autres charges de gestion courante (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '66', nom: 'Charges financières (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '67', nom: 'Charges exceptionnelles (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '68', nom: 'Dotations aux amortissements et provisions (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '69', nom: 'Impôts sur les bénéfices (compte principal)', categorie: 'Charges', classe: '6' },
  { numero: '601', nom: 'Achats de marchandises', categorie: 'Charges', classe: '6' },
  { numero: '6011', nom: 'Achats de marchandises A', categorie: 'Charges', classe: '6' },
  { numero: '6012', nom: 'Achats de marchandises B', categorie: 'Charges', classe: '6' },
  { numero: '602', nom: 'Achats de matières premières', categorie: 'Charges', classe: '6' },
  { numero: '603', nom: 'Variation des stocks', categorie: 'Charges', classe: '6' },
  { numero: '6031', nom: 'Variation des stocks de marchandises', categorie: 'Charges', classe: '6' },
  { numero: '6032', nom: 'Variation des stocks de matières', categorie: 'Charges', classe: '6' },
  { numero: '604', nom: 'Achats d\'études et prestations de services', categorie: 'Charges', classe: '6' },
  { numero: '605', nom: 'Autres achats', categorie: 'Charges', classe: '6' },
  { numero: '6051', nom: 'Fournitures non stockables (eau, énergie)', categorie: 'Charges', classe: '6' },
  { numero: '6052', nom: 'Fournitures d\'entretien et petit équipement', categorie: 'Charges', classe: '6' },
  { numero: '6053', nom: 'Fournitures de bureau', categorie: 'Charges', classe: '6' },
  { numero: '608', nom: 'Frais accessoires d\'achat', categorie: 'Charges', classe: '6' },
  { numero: '609', nom: 'Rabais, remises et ristournes obtenus', categorie: 'Charges', classe: '6' },
  { numero: '610', nom: 'Transports sur achats', categorie: 'Charges', classe: '6' },
  { numero: '611', nom: 'Transports sur ventes', categorie: 'Charges', classe: '6' },
  { numero: '612', nom: 'Transports pour le compte de tiers', categorie: 'Charges', classe: '6' },
  { numero: '613', nom: 'Locations et charges locatives', categorie: 'Charges', classe: '6' },
  { numero: '6132', nom: 'Locations immobilières', categorie: 'Charges', classe: '6' },
  { numero: '6135', nom: 'Locations mobilières', categorie: 'Charges', classe: '6' },
  { numero: '614', nom: 'Charges locatives et de copropriété', categorie: 'Charges', classe: '6' },
  { numero: '615', nom: 'Entretien et réparations', categorie: 'Charges', classe: '6' },
  { numero: '616', nom: 'Primes d\'assurance', categorie: 'Charges', classe: '6' },
  { numero: '617', nom: 'Études et recherches', categorie: 'Charges', classe: '6' },
  { numero: '618', nom: 'Autres services extérieurs', categorie: 'Charges', classe: '6' },
  { numero: '621', nom: 'Personnel extérieur à l\'entreprise', categorie: 'Charges', classe: '6' },
  { numero: '622', nom: 'Rémunérations d\'intermédiaires et honoraires', categorie: 'Charges', classe: '6' },
  { numero: '6221', nom: 'Commissions et courtages', categorie: 'Charges', classe: '6' },
  { numero: '6226', nom: 'Honoraires', categorie: 'Charges', classe: '6' },
  { numero: '6227', nom: 'Frais d\'actes et de contentieux', categorie: 'Charges', classe: '6' },
  { numero: '623', nom: 'Publicité, publications, relations publiques', categorie: 'Charges', classe: '6' },
  { numero: '624', nom: 'Frais de transport et de déplacements', categorie: 'Charges', classe: '6' },
  { numero: '6241', nom: 'Transports du personnel', categorie: 'Charges', classe: '6' },
  { numero: '6242', nom: 'Voyages et déplacements', categorie: 'Charges', classe: '6' },
  { numero: '6243', nom: 'Missions et réceptions', categorie: 'Charges', classe: '6' },
  { numero: '625', nom: 'Frais de télécommunication', categorie: 'Charges', classe: '6' },
  { numero: '626', nom: 'Frais bancaires', categorie: 'Charges', classe: '6' },
  { numero: '627', nom: 'Services bancaires et assimilés', categorie: 'Charges', classe: '6' },
  { numero: '628', nom: 'Divers services extérieurs', categorie: 'Charges', classe: '6' },
  { numero: '629', nom: 'Rabais, remises sur services extérieurs', categorie: 'Charges', classe: '6' },
  { numero: '631', nom: 'Impôts, taxes et versements assimilés', categorie: 'Charges', classe: '6' },
  { numero: '6311', nom: 'Patentes, licences', categorie: 'Charges', classe: '6' },
  { numero: '6312', nom: 'Impôts fonciers', categorie: 'Charges', classe: '6' },
  { numero: '6313', nom: 'Autres impôts locaux', categorie: 'Charges', classe: '6' },
  { numero: '632', nom: 'Taxes sur le chiffre d\'affaires non récupérables', categorie: 'Charges', classe: '6' },
  { numero: '633', nom: 'Impôts sur les traitements et salaires', categorie: 'Charges', classe: '6' },
  { numero: '638', nom: 'Autres impôts et taxes', categorie: 'Charges', classe: '6' },
  { numero: '641', nom: 'Rémunérations du personnel', categorie: 'Charges', classe: '6' },
  { numero: '6411', nom: 'Salaires et appointements', categorie: 'Charges', classe: '6' },
  { numero: '6412', nom: 'Primes et gratifications', categorie: 'Charges', classe: '6' },
  { numero: '6413', nom: 'Congés payés', categorie: 'Charges', classe: '6' },
  { numero: '6414', nom: 'Indemnités et avantages divers', categorie: 'Charges', classe: '6' },
  { numero: '6415', nom: 'Commissions au personnel', categorie: 'Charges', classe: '6' },
  { numero: '645', nom: 'Charges de sécurité sociale', categorie: 'Charges', classe: '6' },
  { numero: '6451', nom: 'Cotisations à la CNSS', categorie: 'Charges', classe: '6' },
  { numero: '6452', nom: 'Cotisations aux mutuelles', categorie: 'Charges', classe: '6' },
  { numero: '6453', nom: 'Cotisations aux caisses de retraite', categorie: 'Charges', classe: '6' },
  { numero: '646', nom: 'Charges sociales sur congés à payer', categorie: 'Charges', classe: '6' },
  { numero: '647', nom: 'Autres charges sociales', categorie: 'Charges', classe: '6' },
  { numero: '648', nom: 'Autres charges de personnel', categorie: 'Charges', classe: '6' },
  { numero: '651', nom: 'Pertes sur créances clients', categorie: 'Charges', classe: '6' },
  { numero: '652', nom: 'Quote-part de résultat sur opérations faites en commun', categorie: 'Charges', classe: '6' },
  { numero: '653', nom: 'Jetons de présence', categorie: 'Charges', classe: '6' },
  { numero: '654', nom: 'Pertes sur créances', categorie: 'Charges', classe: '6' },
  { numero: '658', nom: 'Charges diverses de gestion courante', categorie: 'Charges', classe: '6' },
  { numero: '661', nom: 'Intérêts des emprunts', categorie: 'Charges', classe: '6' },
  { numero: '664', nom: 'Pertes sur créances rattachées à des participations', categorie: 'Charges', classe: '6' },
  { numero: '665', nom: 'Escomptes accordés', categorie: 'Charges', classe: '6' },
  { numero: '666', nom: 'Pertes de change', categorie: 'Charges', classe: '6' },
  { numero: '667', nom: 'Pertes sur cessions de valeurs mobilières', categorie: 'Charges', classe: '6' },
  { numero: '671', nom: 'Intérêts des emprunts et dettes', categorie: 'Charges', classe: '6' },
  { numero: '675', nom: 'Pertes de change', categorie: 'Charges', classe: '6' },
  { numero: '681', nom: 'Dotations aux amortissements d\'exploitation', categorie: 'Charges', classe: '6' },
  { numero: '6811', nom: 'Dotations aux amortissements des immobilisations incorporelles', categorie: 'Charges', classe: '6' },
  { numero: '6812', nom: 'Dotations aux amortissements des immobilisations corporelles', categorie: 'Charges', classe: '6' },
  { numero: '686', nom: 'Dotations aux provisions financières', categorie: 'Charges', classe: '6' },
  { numero: '691', nom: 'Impôts sur les bénéfices', categorie: 'Charges', classe: '6' },
  { numero: '695', nom: 'Impôt minimum forfaitaire (IMF)', categorie: 'Charges', classe: '6' },
  { numero: '697', nom: 'Rappels d\'impôts', categorie: 'Charges', classe: '6' },
  { numero: '699', nom: 'Autres impôts', categorie: 'Charges', classe: '6' },
  
  // Classe 7 - Comptes de produits
  { numero: '70', nom: 'Ventes de produits fabriqués et services (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '71', nom: 'Production stockée (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '72', nom: 'Production immobilisée (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '73', nom: 'Variation des stocks (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '74', nom: 'Subventions d\'exploitation (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '75', nom: 'Autres produits de gestion courante (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '76', nom: 'Produits financiers (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '77', nom: 'Produits exceptionnels (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '78', nom: 'Reprises sur provisions (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '79', nom: 'Transferts de charges (compte principal)', categorie: 'Produits', classe: '7' },
  { numero: '701', nom: 'Ventes de marchandises', categorie: 'Produits', classe: '7' },
  { numero: '7011', nom: 'Ventes de marchandises A', categorie: 'Produits', classe: '7' },
  { numero: '7012', nom: 'Ventes de marchandises B', categorie: 'Produits', classe: '7' },
  { numero: '702', nom: 'Ventes de produits finis', categorie: 'Produits', classe: '7' },
  { numero: '703', nom: 'Ventes de produits intermédiaires', categorie: 'Produits', classe: '7' },
  { numero: '704', nom: 'Ventes de travaux', categorie: 'Produits', classe: '7' },
  { numero: '705', nom: 'Ventes d\'études et prestations de services', categorie: 'Produits', classe: '7' },
  { numero: '706', nom: 'Produits des activités annexes', categorie: 'Produits', classe: '7' },
  { numero: '707', nom: 'Produits accessoires', categorie: 'Produits', classe: '7' },
  { numero: '7071', nom: 'Locations diverses', categorie: 'Produits', classe: '7' },
  { numero: '7072', nom: 'Commissions et courtages', categorie: 'Produits', classe: '7' },
  { numero: '7078', nom: 'Autres produits accessoires', categorie: 'Produits', classe: '7' },
  { numero: '708', nom: 'Produits des opérations faites en commun', categorie: 'Produits', classe: '7' },
  { numero: '709', nom: 'Rabais, remises et ristournes accordés', categorie: 'Produits', classe: '7' },
  { numero: '711', nom: 'Subventions d\'exploitation', categorie: 'Produits', classe: '7' },
  { numero: '721', nom: 'Production immobilisée - Immobilisations incorporelles', categorie: 'Produits', classe: '7' },
  { numero: '722', nom: 'Production immobilisée - Immobilisations corporelles', categorie: 'Produits', classe: '7' },
  { numero: '736', nom: 'Variation des stocks de produits finis', categorie: 'Produits', classe: '7' },
  { numero: '737', nom: 'Variation des en-cours de production de biens', categorie: 'Produits', classe: '7' },
  { numero: '754', nom: 'Redevances pour brevets et licences', categorie: 'Produits', classe: '7' },
  { numero: '758', nom: 'Produits divers de gestion courante', categorie: 'Produits', classe: '7' },
  { numero: '761', nom: 'Revenus des participations', categorie: 'Produits', classe: '7' },
  { numero: '762', nom: 'Revenus des autres immobilisations financières', categorie: 'Produits', classe: '7' },
  { numero: '764', nom: 'Revenus des valeurs mobilières de placement', categorie: 'Produits', classe: '7' },
  { numero: '765', nom: 'Escomptes obtenus', categorie: 'Produits', classe: '7' },
  { numero: '766', nom: 'Gains de change', categorie: 'Produits', classe: '7' },
  { numero: '767', nom: 'Produits nets sur cessions de valeurs mobilières', categorie: 'Produits', classe: '7' },
  { numero: '771', nom: 'Intérêts des prêts et créances', categorie: 'Produits', classe: '7' },
  { numero: '775', nom: 'Gains de change', categorie: 'Produits', classe: '7' },
  { numero: '781', nom: 'Reprises sur amortissements et provisions d\'exploitation', categorie: 'Produits', classe: '7' },
  { numero: '786', nom: 'Reprises de provisions financières', categorie: 'Produits', classe: '7' },
  { numero: '791', nom: 'Reprises de provisions d\'exploitation', categorie: 'Produits', classe: '7' },
  { numero: '798', nom: 'Reprises d\'amortissements', categorie: 'Produits', classe: '7' },
  
  // Classe 8 - Comptes spéciaux
  { numero: '801', nom: 'Résultat d\'exploitation', categorie: 'Résultat', classe: '8' },
  { numero: '810', nom: 'Résultat financier', categorie: 'Résultat', classe: '8' },
  { numero: '820', nom: 'Résultat des activités ordinaires', categorie: 'Résultat', classe: '8' },
  { numero: '830', nom: 'Résultat hors activités ordinaires', categorie: 'Résultat', classe: '8' },
  { numero: '840', nom: 'Impôts sur le résultat', categorie: 'Résultat', classe: '8' },
  { numero: '850', nom: 'Résultat net de l\'exercice', categorie: 'Résultat', classe: '8' },
  { numero: '860', nom: 'Résultat net comptable', categorie: 'Résultat', classe: '8' },
  { numero: '870', nom: 'Compte de résultat de l\'exercice', categorie: 'Résultat', classe: '8' },
  
  // Classe 9 - Comptes analytiques (optionnels)
  { numero: '901', nom: 'Compte de liaison', categorie: 'Analytique', classe: '9' },
  { numero: '902', nom: 'Compte de reclassement', categorie: 'Analytique', classe: '9' },
];

const JOURNAUX_BASE = [
  { code: 'AC', nom: 'Journal des Achats', type: 'achats' },
  { code: 'VT', nom: 'Journal des Ventes', type: 'ventes' },
  { code: 'BQ', nom: 'Journal de Banque', type: 'banque' },
  { code: 'CA', nom: 'Journal de Caisse', type: 'caisse' },
  { code: 'OD', nom: 'Journal des Opérations Diverses', type: 'od' },
  { code: 'SA', nom: 'Journal des Salaires', type: 'od' },
  { code: 'AN', nom: 'Journal à Nouveaux', type: 'od' },
  { code: 'EX', nom: 'Journal des Extournes', type: 'od' },
];

export async function initializeSyscohadaForEnterprise(entrepriseId) {
  const eId = parseInt(entrepriseId);
  
  console.log(`Initialisation du plan comptable SYSCOHADA pour entreprise ${eId}...`);
  
  // Vérifier si des comptes existent déjà
  const existingComptes = await db.select().from(comptesComptables)
    .where(eq(comptesComptables.entrepriseId, eId));
  
  if (existingComptes.length > 10) {
    console.log(`Plan comptable déjà initialisé pour entreprise ${eId} (${existingComptes.length} comptes)`);
    return { 
      success: true, 
      message: 'Plan comptable déjà initialisé',
      comptesExistants: existingComptes.length 
    };
  }

  // Insérer tous les comptes SYSCOHADA
  let insertedCount = 0;
  for (const compte of PLAN_SYSCOHADA) {
    try {
      await db.insert(comptesComptables).values({
        entrepriseId: eId,
        numero: compte.numero,
        nom: compte.nom,
        type: compte.categorie.toLowerCase(),
        classe: compte.classe,
        actif: true
      });
      insertedCount++;
    } catch (err) {
      // Ignorer les doublons
    }
  }

  // Créer les journaux de base
  let journauxCount = 0;
  for (const journal of JOURNAUX_BASE) {
    try {
      await db.insert(journaux).values({
        entrepriseId: eId,
        code: journal.code,
        nom: journal.nom,
        type: journal.type,
        actif: true
      });
      journauxCount++;
    } catch (err) {
      // Ignorer les doublons
    }
  }

  console.log(`Plan comptable SYSCOHADA initialisé: ${insertedCount} comptes, ${journauxCount} journaux`);
  
  return {
    success: true,
    message: 'Plan comptable SYSCOHADA initialisé avec succès',
    comptesCreés: insertedCount,
    journauxCreés: journauxCount,
    totalComptes: PLAN_SYSCOHADA.length
  };
}

export { PLAN_SYSCOHADA, JOURNAUX_BASE };
