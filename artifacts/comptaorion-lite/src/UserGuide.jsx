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
          <span>Si vous vous abonnez après l’essai, les 2 premiers mois de l’abonnement sont offerts : la facturation commence au 3e mois.</span>
        </div>
      </section>

      <div className="guide-content">
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
      </div>

      <footer className="guide-footer">ComptaOrion Lite · Guide destiné aux utilisateurs de la version test</footer>
    </main>
  );
}
