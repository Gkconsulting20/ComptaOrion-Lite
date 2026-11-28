import { Link } from 'wouter';
import './guide.css';

const features = [
  ['Ventes de prestations', 'Factures multi-lignes, clients et dettes, reçus. Relance WhatsApp des impayés.'],
  ['Prestations', 'Catalogue de prestations et tarifs. Aucun stock : Lite est réservé aux services.'],
  ['TVA', 'Taux choisi à l’inscription : 0 %, 18 % (par défaut) ou taux personnalisé. Les factures affichent le montant hors taxes, la TVA et le total TTC.'],
  ['Dépenses', 'Enregistrement des dépenses, avec approbations et remboursements.'],
  ['Employés', 'Annuaire des employés dans le module Dépenses. Un employé peut être lié à son compte utilisateur, si vous le souhaitez — aucune liaison automatique n’est imposée.'],
  ['Saisie par photo', 'Préparer une dépense à partir d’une facture ou d’un reçu (photo JPEG, PNG ou WebP).'],
  ['Caisse et banque', 'Trésorerie alimentée par les encaissements et les décaissements (dépenses directes et remboursements). Les chèques ne sont pas pris en charge.'],
  ['Reçus et rapports', 'Rapport du jour, reçus, état de résultat et bilan. Impression ou enregistrement en PDF.'],
  ['Clôture d’exercice', 'Clôture et réouverture d’exercice, sans double-compte.'],
  ['Hors connexion', 'Ventes et dépenses mises en attente sur l’appareil sans réseau, puis synchronisées au retour de la connexion.'],
  ['Réglages', 'Langue et devise d’affichage, installation sur l’écran d’accueil du téléphone.'],
];

const plans = [
  {
    nom: 'Services',
    prix: '2 500',
    devise: 'FCFA / mois',
    description: 'Pour démarrer seul ou en petite équipe.',
    points: [
      '3 utilisateurs',
      '3 Go de stockage',
      'Toutes les fonctionnalités de ComptaOrion Lite : ventes, dépenses, TVA, caisse et banque, rapports',
    ],
  },
  {
    nom: 'Équipe',
    prix: '10 000',
    devise: 'FCFA / mois',
    description: 'Pour les équipes qui grandissent.',
    points: [
      '10 utilisateurs',
      '10 Go de stockage',
      'Toutes les fonctionnalités de ComptaOrion Lite : ventes, dépenses, TVA, caisse et banque, rapports',
      'Assistance prioritaire',
    ],
  },
];

export default function UserGuide() {
  return (
    <main className="user-guide-page">
      <header className="guide-header">
        <Link className="guide-brand" href="/">
          <img src="/logo-comptaorion.png" alt="" />
          <span>ComptaOrion <b>Lite</b></span>
        </Link>
        <div className="guide-header-actions">
          <button className="guide-print" type="button" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button>
          <Link className="guide-back" href="/">Retour à l’application</Link>
        </div>
      </header>

      <section className="guide-hero">
        <span className="guide-kicker">Guide client · version test</span>
        <h1>Votre activité, simplement.</h1>
        <p>ComptaOrion Lite est conçu pour les prestataires de services — professions libérales, consultants, artisans de service, etc. — et non pour les activités d’achat-revente de marchandises. Il n’y a donc ni stock ni achats de marchandises dans Lite : ce n’est pas une limitation, c’est le positionnement du logiciel.</p>
        <div className="guide-callout">
          <strong>Essai gratuit de 30 jours, puis 2 mois offerts</strong>
          <span>L’essai de 30 jours démarre le jour où vous vérifiez votre adresse e-mail. Si vous vous abonnez après l’essai, les 2 premiers mois de l’abonnement sont offerts : la facturation commence au 3e mois.</span>
          <a href="#forfaits">Voir les forfaits : Services 2 500 FCFA/mois · Équipe 10 000 FCFA/mois</a>
        </div>
      </section>

      <div className="guide-content">
        <section className="guide-section" id="forfaits">
          <div>
            <h2>Nos forfaits</h2>
            <p>Deux forfaits mensuels, en FCFA. Essai gratuit de 30 jours à partir de la vérification de votre adresse e-mail, puis 2 mois offerts sur l’abonnement : la facturation commence au 3e mois.</p>
            <div className="guide-plans">
              {plans.map((plan) => (
                <article className="guide-plan" key={plan.nom}>
                  <h3>{plan.nom}</h3>
                  <p className="guide-plan-price"><strong>{plan.prix}</strong> <span>{plan.devise}</span></p>
                  <p className="guide-plan-description">{plan.description}</p>
                  <ul>
                    {plan.points.map((point) => <li key={point}>{point}</li>)}
                  </ul>
                </article>
              ))}
            </div>
            <div className="guide-final-actions">
              <Link className="guide-back guide-back-primary" href="/">Essayer gratuitement 30 jours</Link>
            </div>
          </div>
        </section>

        <section className="guide-section">
          <div>
            <h2>Ce que permet ComptaOrion Lite</h2>
            <ul>
              {features.map(([title, text]) => <li key={title}><b>{title} : </b>{text}</li>)}
            </ul>
            <div className="guide-final-actions">
              <Link className="guide-back guide-back-primary" href="/">Ouvrir ComptaOrion Lite</Link>
              <button className="guide-print guide-print-secondary" type="button" onClick={() => window.print()}>Imprimer ce guide</button>
            </div>
          </div>
        </section>

        <section className="guide-section" id="verification-email">
          <div>
            <h2>Vérification de votre adresse e-mail</h2>
            <p>À l’inscription, un code à 6 chiffres est envoyé à votre adresse e-mail. Vous devez le saisir pour activer votre compte : tant que l’adresse n’est pas vérifiée, la connexion est refusée. Le code est valable 15 minutes ; après 5 tentatives incorrectes, il est invalidé et un nouveau code doit être demandé. Un nouveau code peut être renvoyé après 60 secondes (3 renvois maximum par heure). Si vous vous êtes trompé d’adresse, vous pouvez la corriger avant de demander un nouveau code.</p>
            <p>Votre essai gratuit de 30 jours démarre le jour où vous vérifiez votre adresse e-mail, pas le jour de l’inscription. Un compte dont l’adresse n’est jamais vérifiée est supprimé après 7 jours. Les comptes créés par le propriétaire d’une entreprise pour ses collaborateurs, et les entreprises de démonstration, ne sont pas concernés par cette vérification.</p>
          </div>
        </section>
      </div>

      <footer className="guide-footer">ComptaOrion Lite · Guide destiné aux utilisateurs de la version test</footer>
    </main>
  );
}
