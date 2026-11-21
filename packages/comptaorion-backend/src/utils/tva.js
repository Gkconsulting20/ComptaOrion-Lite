// Taux de TVA — réglage de l'entreprise (décision Cap, 21 nov. 2026).
//
// Le taux est choisi par l'utilisateur à la création de l'entreprise :
// 0 % (exonéré), 18 % (taux normal, DÉFAUT — ne pas changer) ou un taux
// personnalisé saisi librement (0 à 100 %). Il est stocké sur
// entreprises.taux_tva et appliqué automatiquement partout (ventes,
// achats, devis, commandes) ; il ne doit JAMAIS être codé en dur.
//
// Règle critique : un taux de 0 % est une valeur valide. Ne jamais écrire
// `taux || 18` ou `taux ? taux : 18` : 0 est falsy et retomberait à 18 %.
// Utiliser `tauxTvaEntreprise()` (qui s'appuie sur ??) partout.

export const TAUX_TVA_DEFAUT = 18;

// Taux de TVA par pays/région (référentiel affiché par GET /api/parametres/taux-tva).
export const TAUX_TVA_PAR_PAYS = {
  // Afrique (Zone UEMOA/CEMAC - SYSCOHADA)
  Bénin: 18,
  'Burkina Faso': 18,
  "Côte d'Ivoire": 18,
  Mali: 18,
  Niger: 19,
  Sénégal: 18,
  Togo: 18,
  Cameroun: 19.25,
  Gabon: 18,

  // Afrique du Nord
  Maroc: 20,
  Tunisie: 19,
  Algérie: 19,
  Égypte: 14,

  // Afrique subsaharienne
  'Afrique du Sud': 15,
  Nigeria: 7.5,
  Ghana: 12.5,
  Kenya: 16,

  // Europe
  France: 20,
  Belgique: 21,
  Allemagne: 19,
  Espagne: 21,
  Italie: 22,
  'Royaume-Uni': 20,
  Suisse: 8.1,

  // Amérique
  'États-Unis': 0, // Varie par État
  Canada: 5, // TPS fédérale (+ taxes provinciales)
  Brésil: 17,

  // Par défaut
  default: 18,
};

/** Taux de TVA de référence pour un pays (défaut 18 % si pays inconnu). */
export function tauxTvaParPays(pays) {
  if (typeof pays === 'string' && pays.trim()) {
    const taux = TAUX_TVA_PAR_PAYS[pays.trim()];
    if (typeof taux === 'number') return taux;
  }
  return TAUX_TVA_PAR_PAYS.default;
}

/**
 * Normalise un taux de TVA fourni par l'utilisateur.
 * Retourne le taux (nombre, 0 à 100 inclus) ou null si la valeur est
 * absente ou invalide. 0 est valide (exonération) : il n'est pas confondu
 * avec « non renseigné ».
 */
export function normaliserTauxTva(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return null;
  const texte = String(valeur).trim().replace(',', '.');
  const taux = typeof valeur === 'number' ? valeur : parseFloat(texte);
  if (!Number.isFinite(taux) || taux < 0 || taux > 100) return null;
  return Math.round(taux * 100) / 100;
}

/**
 * Taux de TVA effectif d'une entreprise (ligne entreprises, colonne
 * taux_tva en décimal — souvent une chaîne comme '18.00').
 * 0 % reste 0 % ; valeur absente ou illisible -> défaut 18 %.
 */
export function tauxTvaEntreprise(entreprise, defaut = TAUX_TVA_DEFAUT) {
  const brut = entreprise?.tauxTva ?? entreprise?.taux_tva;
  if (brut === undefined || brut === null || brut === '') return defaut;
  const taux = Number(brut);
  return Number.isFinite(taux) && taux >= 0 && taux <= 100 ? taux : defaut;
}

/** TVA arrondie au centime sur un montant HT, au taux de l'entreprise. */
export function calculerTva(totalHT, taux) {
  const ht = Number(totalHT) || 0;
  const tauxNormalise = normaliserTauxTva(taux);
  if (tauxNormalise === null) return 0;
  return Math.round((ht * tauxNormalise / 100 + Number.EPSILON) * 100) / 100;
}
