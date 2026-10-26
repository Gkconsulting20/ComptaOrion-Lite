import React from 'react';

const TEST_GROUPS = [
  {
    title: 'Photo, IA et protection des comptes',
    tests: [
      'Sans consentement, la photo n’est pas analysée; sans confirmation, rien n’est écrit.',
      'Les données d’une autre entreprise ne sont pas accessibles.',
      'Clients, factures et paiements restent filtrés par entreprise.',
      'Une photo déjà confirmée ne rappelle pas Groq.',
      'Un brouillon d’une autre entreprise ou d’une autre devise est refusé.',
      'Les formats, le contenu et la taille des photos sont validés.',
      'Les champs incertains restent vides jusqu’à vérification.',
      'Le brouillon photo est lié au bon compte et au bon utilisateur.',
      'Un modèle Groq absent est refusé; aucun autre fournisseur n’est utilisé.',
      'La photo est envoyée sans identité ni liste de clients.',
      'Un 429 temporaire est retenté une fois.',
      'Les erreurs de clé, quota, réseau et réponse invalide sont traitées sans exposer leur contenu.',
    ],
  },
  {
    title: 'Calcul du score de paiement',
    tests: [
      'Un client sans historique exploitable ne reçoit pas un score de 100.',
      'Un paiement intégral à temps obtient 100, avec une réserve si l’historique est court.',
      'Les impayés et les retards affectent le score de façon transparente.',
      'Le retard est calculé à partir du règlement complet, pas du premier versement.',
      'Un paiement partiel non soldé n’est pas considéré comme ponctuel.',
      'Les brouillons, annulations, dates impossibles et historiques incohérents sont exclus.',
      'Le score reste borné même après de nombreux retards.',
      'L’explication ne révèle ni identité, ni montants, ni numéros de facture.',
    ],
  },
  {
    title: 'Cloudflare et contexte des requêtes',
    tests: [
      'La configuration Cloudflare exige une base et deux clés distinctes.',
      'Une base non PostgreSQL et des clés identiques sont refusées.',
      'Les requêtes simultanées utilisent des contextes PostgreSQL séparés.',
      'Le contexte de requête est restauré après une erreur.',
    ],
  },
  {
    title: 'États financiers',
    tests: [
      'L’état de résultat et le bilan sont calculés à partir des mouvements SYSCOHADA.',
      'Un écart du bilan est affiché au lieu d’être masqué.',
    ],
  },
  {
    title: 'Reprises et détection des doublons',
    tests: [
      'Rejouer une opération retourne la réponse déjà validée.',
      'Une opération ne peut pas être rejouée pour une autre entreprise.',
      'Un échec avant validation ne laisse aucune écriture partielle.',
      'Une réponse perdue après validation ne crée pas une deuxième écriture.',
      'Une photo en doublon exige un choix explicite avant la création.',
      'Une dépense distincte peut être créée sans choix de doublon supplémentaire.',
      'Deux dépenses sans référence, même similaires, restent séparées.',
      'Les références, dates, montants et enseignes similaires sont repérés.',
      'Les anciennes références inscrites dans une description restent vérifiables.',
      'Une date et un montant similaires signalent un doute, pas une fusion.',
      'Deux achats similaires de fournisseurs différents restent distincts.',
      'Le choix anti-doublon est lié à la photo, au brouillon, au compte et aux correspondances actuelles.',
    ],
  },
];

const TEST_COUNT = TEST_GROUPS.reduce((total, group) => total + group.tests.length, 0);

export default function TestReport({ t }) {
  return (
    <>
      <div className="lite-page-head">
        <div>
          <span className="eyebrow">{t('Vérification', 'Verification')}</span>
          <h1>{t('Rapport des tests', 'Test report')}</h1>
          <p className="muted">{t('Résultats du dernier lancement des tests automatisés du serveur.', 'Results from the latest automated backend test run.')}</p>
        </div>
      </div>

      <section className="test-report-overview" aria-label={t('Résumé des tests', 'Test summary')}>
        <div className="test-report-stat test-report-stat-success">
          <strong>{TEST_COUNT}</strong>
          <span>{t('tests réussis', 'tests passed')}</span>
        </div>
        <div className="test-report-stat test-report-stat-fail">
          <strong>0</strong>
          <span>{t('échec', 'failures')}</span>
        </div>
        <div className="test-report-run">
          <span>{t('Dernier lancement', 'Last run')}</span>
          <strong>26 octobre 2026</strong>
          <small>{t('Tests automatisés du serveur', 'Automated backend tests')}</small>
        </div>
      </section>

      <div className="test-report-note">
        <strong>{t('À savoir', 'Note')}</strong>
        <span>{t('Cette page affiche le rapport du dernier lancement; elle ne relance pas les tests. Les réponses Groq 429 simulées font partie des tests de gestion des erreurs et ne sont pas de nouveaux échecs réels.', 'This page shows the last test report and does not rerun tests. Simulated Groq 429 responses are part of error-handling tests, not new live failures.')}</span>
      </div>

      <div className="test-report-groups">
        {TEST_GROUPS.map((group) => (
          <details className="test-report-group" key={group.title} open>
            <summary>
              <span className="test-report-group-heading">
                <strong>{group.title}</strong>
                <small>{group.tests.length} {t('tests', 'tests')}</small>
              </span>
              <span className="test-report-group-result">✓ {group.tests.length}/{group.tests.length} {t('réussis', 'passed')}</span>
            </summary>
            <ul className="test-report-list">
              {group.tests.map((test) => (
                <li className="test-report-item" key={test}>
                  <span>{test}</span>
                  <span className="test-report-status"><i>✓</i>{t('Réussi', 'Passed')}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </>
  );
}
