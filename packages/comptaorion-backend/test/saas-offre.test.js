import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOIS_GRATUITS_ABONNEMENT,
  calculerOffreAbonnement,
  commissionSur,
  creerAbonnementPayant,
  dateDebutFacturation,
  moisPayants,
  montantPayant,
} from '../src/saas-offre.js';
import { abonnements, plansAbonnement, saasClients, saasCommerciaux } from '../src/schema.js';

// Offre « 2 mois gratuits sur l'abonnement » (20 nov. 2026) :
// l'essai reste à 30 jours (voir trial-access.test.js, non modifié ici).

test('l’offre est de 2 mois gratuits sur chaque nouvel abonnement payant', () => {
  assert.equal(MOIS_GRATUITS_ABONNEMENT, 2);
});

test('mois payants : la durée moins les mois gratuits, jamais négatif', () => {
  assert.equal(moisPayants(12), 10);
  assert.equal(moisPayants(6), 4);
  assert.equal(moisPayants(3), 1);
  assert.equal(moisPayants(2), 0);
  assert.equal(moisPayants(1), 0);
});

test('montant payant : prix mensuel × mois payants', () => {
  // Plan Lite Standard, 2 500 FCFA/mois (prix de lancement proposé).
  assert.equal(montantPayant(2500, 12), 25000);
  assert.equal(montantPayant(2500, 6), 10000);
  assert.equal(montantPayant(2500, 2), 0);
  assert.equal(montantPayant(2500, 1), 0);
  // Arrondi à 2 décimales.
  assert.equal(montantPayant(1999.99, 12), 19999.9);
});

test('la facturation commence 2 mois après le début de l’abonnement', () => {
  assert.equal(dateDebutFacturation('2026-11-20'), '2027-01-20');
  assert.equal(dateDebutFacturation(new Date('2026-11-20T00:00:00.000Z')), '2027-01-20');
});

test('commission de 10 % calculée sur le montant payé uniquement', () => {
  assert.equal(commissionSur(25000), 2500);
  assert.equal(commissionSur(10000), 1000);
  assert.equal(commissionSur(0), 0);
});

test('calcul complet : 12 mois à 2 500 FCFA/mois', () => {
  assert.deepEqual(calculerOffreAbonnement({ prixMensuel: 2500, dureeEnMois: 12, dateDebut: '2026-11-20' }), {
    moisGratuits: 2,
    moisPayants: 10,
    montantTotal: 25000,
    dateDebutFacturation: '2027-01-20',
    dateExpiration: '2027-11-20',
    entierementGratuit: false,
  });
});

test('calcul complet : durée de 2 mois, entièrement gratuit', () => {
  const offre = calculerOffreAbonnement({ prixMensuel: 2500, dureeEnMois: 2, dateDebut: '2026-11-20' });
  assert.equal(offre.moisPayants, 0);
  assert.equal(offre.montantTotal, 0);
  assert.equal(offre.entierementGratuit, true);
  assert.equal(offre.dateDebutFacturation, '2027-01-20');
  assert.equal(offre.dateExpiration, '2027-01-20');
});

// --- Création d'abonnement (chemin administrateur) ---

function stubDb({ client, plan, commercial }) {
  const inserts = [];
  const updates = [];
  const rowsFor = (table) => (
    table === saasClients ? (client ? [client] : [])
    : table === plansAbonnement ? (plan ? [plan] : [])
    : table === saasCommerciaux ? (commercial ? [commercial] : [])
    : []
  );
  return {
    inserts,
    updates,
    select: () => ({
      from: (table) => ({
        where: () => ({ limit: async () => rowsFor(table) }),
      }),
    }),
    insert: (table) => ({
      values: (values) => {
        inserts.push({ table, values });
        const row = { id: table === abonnements ? 101 : 201, ...values };
        return { returning: async () => [row] };
      },
    }),
    update: () => ({
      set: (values) => {
        updates.push(values);
        return { where: () => Promise.resolve([]) };
      },
    }),
  };
}

const clientBase = { id: 7, entrepriseId: 42, commercialId: 3, statut: 'trial' };
const planBase = { id: 5, nom: 'Standard', prix: '2500', actif: true };
const commercialBase = { id: 3, nom: 'Doe', prenom: 'Jane' };

test('création admin : abonnement de 12 mois, vente et commission sur les mois payés', async () => {
  const db = stubDb({ client: clientBase, plan: planBase, commercial: commercialBase });
  const { abonnement, offre, commission } = await creerAbonnementPayant(db, {
    entrepriseId: 42,
    planId: 5,
    dateDebut: '2026-11-20',
    dureeEnMois: 12,
  });

  assert.equal(offre.moisGratuits, 2);
  assert.equal(offre.moisPayants, 10);
  assert.equal(offre.montantTotal, 25000);
  assert.equal(offre.dateDebutFacturation, '2027-01-20');
  assert.equal(commission, 2500);

  const abonnementInsere = db.inserts.find((item) => item.table === abonnements);
  assert.equal(abonnementInsere.values.moisGratuits, 2);
  assert.equal(abonnementInsere.values.dateDebutFacturation.toISOString().slice(0, 10), '2027-01-20');
  assert.equal(abonnementInsere.values.montantMensuel, '2500');
  assert.equal(abonnement.id, 101);

  const venteInseree = db.inserts.find((item) => item.table !== abonnements);
  assert.equal(venteInseree.values.montantVente, 25000);
  assert.equal(venteInseree.values.commission, 2500);
  assert.equal(venteInseree.values.dateEcheanceCommission.toISOString().slice(0, 10), '2027-01-20');
  assert.match(venteInseree.values.notes, /2 mois gratuits, facturation dès le 2027-01-20/);

  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].statut, 'actif');
});

test('création admin : durée de 2 mois, vente à 0 FCFA', async () => {
  const db = stubDb({ client: clientBase, plan: planBase, commercial: commercialBase });
  const { offre, commission } = await creerAbonnementPayant(db, {
    entrepriseId: 42,
    planId: 5,
    dateDebut: '2026-11-20',
    dureeEnMois: 2,
  });
  assert.equal(offre.montantTotal, 0);
  assert.equal(commission, 0);
  assert.equal(offre.entierementGratuit, true);
  const venteInseree = db.inserts.find((item) => item.table !== abonnements);
  assert.equal(venteInseree.values.montantVente, 0);
  assert.equal(venteInseree.values.commission, 0);
});

test('création admin : sans commercial assigné, la création est refusée', async () => {
  const db = stubDb({
    client: { ...clientBase, commercialId: null },
    plan: planBase,
    commercial: null,
  });
  await assert.rejects(
    creerAbonnementPayant(db, { entrepriseId: 42, planId: 5, dateDebut: '2026-11-20', dureeEnMois: 12 }),
    /pas de commercial assigné/,
  );
});

test('création admin : erreurs quand le client, le plan ou la durée est invalide', async () => {
  const sansClient = stubDb({ client: null, plan: planBase, commercial: commercialBase });
  await assert.rejects(
    creerAbonnementPayant(sansClient, { entrepriseId: 42, planId: 5, dateDebut: '2026-11-20', dureeEnMois: 12 }),
    /pas enregistrée comme client SaaS/,
  );

  const sansPlan = stubDb({ client: clientBase, plan: null, commercial: commercialBase });
  const erreurPlan = await creerAbonnementPayant(sansPlan, {
    entrepriseId: 42, planId: 5, dateDebut: '2026-11-20', dureeEnMois: 12,
  }).catch((error) => error);
  assert.equal(erreurPlan.statut, 404);

  const db = stubDb({ client: clientBase, plan: planBase, commercial: commercialBase });
  await assert.rejects(
    creerAbonnementPayant(db, { entrepriseId: 42, planId: 5, dateDebut: '2026-11-20', dureeEnMois: 0 }),
    /au moins 1 mois/,
  );
  await assert.rejects(
    creerAbonnementPayant(db, { entrepriseId: 42, planId: 5, dateDebut: 'date-invalide', dureeEnMois: 12 }),
    /date de début est invalide/,
  );
});
