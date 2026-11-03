import { Link } from 'wouter';
import './guide.css';

const sections = [
  ['demarrer', 'Bien démarrer'],
  ['ventes', 'Ventes et clients'],
  ['achats-stock', 'Achats et stock'],
  ['depenses', 'Dépenses'],
  ['photo', 'Saisie par photo'],
  ['rapports', 'Rapports financiers'],
  ['hors-connexion', 'Hors connexion'],
  ['reglages', 'Réglages et accès'],
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
        <p>Ce guide vous accompagne pour enregistrer vos ventes, suivre vos achats et consulter vos chiffres dans ComptaOrion Lite.</p>
        <div className="guide-callout">
          <strong>Essai gratuit de 30 jours</strong>
          <span>La période commence à la création de votre compte. Après son échéance, l’accès est suspendu, mais vos données restent conservées. Contactez la personne qui vous a transmis le lien pour demander la suite.</span>
        </div>
      </section>

      <nav className="guide-toc" aria-label="Sections du guide">
        <strong>Dans ce guide</strong>
        <div>{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</div>
      </nav>

      <div className="guide-content">
        <section className="guide-section" id="demarrer">
          <span className="guide-number">01</span>
          <div>
            <h2>Bien démarrer</h2>
            <ol>
              <li>Ouvrez le lien de test, puis choisissez <b>Créer un compte</b>.</li>
              <li>Renseignez votre nom d’utilisateur, votre adresse e-mail et un mot de passe d’au moins 12 caractères. Le nom et le téléphone de l’entreprise sont facultatifs à l’inscription.</li>
              <li>Après la création, connectez-vous avec la même adresse e-mail et le même mot de passe.</li>
              <li>Depuis <b>Réglages</b>, choisissez la langue et la devise affichée. Le choix de devise ne convertit pas les montants.</li>
            </ol>
            <p className="guide-tip">Pour commencer, ajoutez d’abord vos produits et votre stock initial dans <b>Stock</b>.</p>
          </div>
        </section>

        <section className="guide-section" id="ventes">
          <span className="guide-number">02</span>
          <div>
            <h2>Ventes et clients</h2>
            <h3>Enregistrer une vente</h3>
            <ol>
              <li>Dans <b>Ventes</b>, cliquez sur <b>Nouvelle vente</b>.</li>
              <li>Choisissez un client ou créez-le sans quitter la vente.</li>
              <li>Pour chaque ligne, sélectionnez un produit ou saisissez une description libre, puis indiquez la quantité et le prix unitaire. Utilisez <b>Ajouter un article</b> pour une vente de plusieurs produits.</li>
              <li>Indiquez le montant reçu maintenant. Le solde restant apparaîtra dans <b>Clients &amp; dettes</b>. Vérifiez les articles et les montants avant d’enregistrer.</li>
            </ol>
            <p>Lorsqu’un produit du stock est associé à une vente, sa quantité disponible est mise à jour après l’enregistrement.</p>
            <h3>Suivre un client ou une dette</h3>
            <p>Dans <b>Clients &amp; dettes</b>, retrouvez les factures impayées, enregistrez un paiement partiel ou complet et, si un numéro est disponible, ouvrez une relance WhatsApp. L’analyse des paiements donne un score indicatif fondé sur l’historique : ce n’est pas une décision de crédit.</p>
          </div>
        </section>

        <section className="guide-section" id="achats-stock">
          <span className="guide-number">03</span>
          <div>
            <h2>Achats et stock</h2>
            <ol>
              <li>Dans <b>Achats</b>, ouvrez l’onglet <b>Fournisseurs</b> et ajoutez le fournisseur.</li>
              <li>Ouvrez <b>Factures d’achat</b>, puis <b>Saisir un achat</b>.</li>
              <li>Sélectionnez le fournisseur, ajoutez la référence et la date de facture si vous les avez, puis choisissez les produits, quantités et prix unitaires.</li>
              <li>Après l’enregistrement, la facture apparaît dans les achats et le stock des produits concernés augmente.</li>
            </ol>
            <p>Dans <b>Stock</b>, créez un produit avec son nom, son prix de vente, la quantité initiale et un seuil bas. Pour corriger une quantité, utilisez <b>Ajuster</b> : une valeur positive ajoute du stock, une valeur négative en retire.</p>
            <p className="guide-tip">Une facture d’achat met à jour le stock et la comptabilité : cette opération nécessite Internet.</p>
          </div>
        </section>

        <section className="guide-section" id="depenses">
          <span className="guide-number">04</span>
          <div>
            <h2>Enregistrer une dépense</h2>
            <ol>
              <li>Ouvrez <b>Dépenses</b>, puis <b>Nouvelle dépense</b>.</li>
              <li>Saisissez une description, le montant et le mode de paiement, puis enregistrez.</li>
              <li>La dépense est visible dans la liste et prise en compte dans les rapports correspondants.</li>
            </ol>
            <p>Une dépense peut être mise en attente sur cet appareil si Internet est coupé. Elle sera envoyée au retour de la connexion; vérifiez ensuite que le compteur « à synchroniser » disparaît.</p>
          </div>
        </section>

        <section className="guide-section" id="photo">
          <span className="guide-number">05</span>
          <div>
            <h2>Saisir une dépense par photo</h2>
            <p>La saisie photo sert à préparer une dépense à partir d’une facture ou d’un reçu d’achat. Elle ne sert pas à saisir une vente ni un encaissement.</p>
            <ol>
              <li>Ouvrez <b>Saisie par photo</b>, puis prenez une photo ou choisissez un fichier JPEG, PNG ou WebP de 4 Mo maximum.</li>
              <li>Masquez les renseignements personnels qui ne sont pas nécessaires, puis cochez le consentement à l’envoi pour analyse.</li>
              <li>Lancez l’analyse et relisez le brouillon : description, fournisseur, montant, date, référence, devise et mode de paiement.</li>
              <li>Corrigez les champs au besoin, cochez la confirmation, puis choisissez <b>Enregistrer la dépense</b>.</li>
            </ol>
            <p className="guide-warning"><b>Vérifiez toujours le brouillon avant l’enregistrement.</b> La photo doit être lisible. Si une dépense ressemblante est déjà trouvée, vérifiez les deux achats avant de décider si le nouveau doit être enregistré.</p>
            <p>L’analyse nécessite une connexion et Groq doit être configuré. ComptaOrion Lite ne conserve pas l’image; le fournisseur d’IA applique sa propre politique de traitement des données.</p>
          </div>
        </section>

        <section className="guide-section" id="rapports">
          <span className="guide-number">06</span>
          <div>
            <h2>Reçus et rapports financiers</h2>
            <p>Dans <b>Reçus &amp; rapports</b>, consultez le rapport du jour, ouvrez un reçu récent, puis imprimez-le ou téléchargez-le en image. L’option d’impression du navigateur permet aussi d’enregistrer un PDF.</p>
            <p>La section <b>États financiers</b> présente l’état de résultat et le bilan. Choisissez les dates, sélectionnez le rapport souhaité, puis utilisez <b>Imprimer / PDF</b>.</p>
            <p className="guide-warning">Si l’application signale des écritures provisoires ou déséquilibrées, vérifiez les opérations avant de vous fier aux chiffres. Pendant le test, ces rapports servent au suivi de l’activité et doivent être relus.</p>
          </div>
        </section>

        <section className="guide-section" id="hors-connexion">
          <span className="guide-number">07</span>
          <div>
            <h2>Travailler hors connexion</h2>
            <p>Le voyant en haut de l’écran indique si l’application est en ligne. Les ventes et dépenses peuvent être mises en attente sur l’appareil lorsque le réseau est absent; elles ne sont pas encore enregistrées sur le serveur.</p>
            <ul>
              <li>Le nombre d’opérations en attente apparaît dans le bouton de synchronisation.</li>
              <li>Reconnectez-vous à Internet : la synchronisation démarre automatiquement. Vous pouvez aussi toucher le compteur pour réessayer.</li>
              <li>Gardez le même appareil et ne videz pas les données du navigateur tant que des opérations sont en attente.</li>
              <li>Les achats, ajustements de stock et analyses photo nécessitent une connexion.</li>
            </ul>
          </div>
        </section>

        <section className="guide-section" id="reglages">
          <span className="guide-number">08</span>
          <div>
            <h2>Réglages, accès et aide</h2>
            <ul>
              <li>Dans <b>Réglages</b>, modifiez la langue et la devise d’affichage ou installez l’application sur l’écran d’accueil de votre téléphone.</li>
              <li>Utilisez <b>Se déconnecter</b> quand vous avez terminé, surtout sur un appareil partagé.</li>
              <li>L’essai dure 30 jours par entreprise. Après l’échéance, l’accès est suspendu et les données restent conservées.</li>
              <li>Si vous ne recevez pas le courriel de récupération du mot de passe pendant ce test, contactez la personne qui vous a envoyé le lien d’accès.</li>
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
