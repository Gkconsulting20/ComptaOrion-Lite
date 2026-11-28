// Service e-mail unique de ComptaOrioLite (28 nov. 2026).
//
// Transport : webhook Make (scénario « E-mails ORIONEXA » : webhook +
// module Gmail connecté à admin@orionexa.net, sur ON). L'application POSTe
// { to, subject, message } (message = HTML) vers l'URL lue dans
// MAKE_WEBHOOK_URL. Un seul point d'envoi pour les codes de vérification,
// le mot de passe oublié, les invitations et les factures.
// SendGrid est abandonné (SENDGRID_API_KEY absente) : aucune importation
// @sendgrid/mail ne doit subsister ici.
//
// Si MAKE_WEBHOOK_URL est absent : l'envoi ne plante jamais l'appelant —
// sendEmail journalise l'échec en base et retourne success:false, pour que
// l'inscription aboutisse quand même et que le code reste renvoyable quand
// le secret est remis.
import { db } from '../db.js';
import { historiqueEmails } from '../schema.js';
import { eq } from 'drizzle-orm';

const WEBHOOK_TIMEOUT_MS = 15000;

class EmailService {
  constructor() {
    this.webhookUrl = process.env.MAKE_WEBHOOK_URL || '';
    // `enabled` est lu au moment de l'envoi (pas au chargement du module) :
    // en Worker Cloudflare, les secrets sont injectés dans process.env à
    // chaque requête ; figer la valeur au premier import serait fragile.
    if (!this.webhookUrl) {
      console.warn('⚠️  MAKE_WEBHOOK_URL non configurée - Les emails ne seront pas envoyés');
    }
    this.fromEmail = 'admin@orionexa.net';
    this.fromName = 'ComptaOrioLite';
  }

  get enabled() {
    return Boolean(process.env.MAKE_WEBHOOK_URL);
  }

  get webhook() {
    return process.env.MAKE_WEBHOOK_URL || '';
  }

  async postToWebhook({ to, subject, message }) {
    const webhookUrl = this.webhook;
    if (!webhookUrl) {
      return { success: false, error: 'MAKE_WEBHOOK_URL non configurée' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, message }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { success: false, error: `Webhook Make : HTTP ${response.status} ${detail}`.trim() };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.name === 'AbortError' ? 'Webhook Make : délai dépassé' : String(error?.message || error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Envoie un email via le webhook Make. L'historique n'est inscrit que
   * quand l'entreprise est connue (colonne entreprise_id NOT NULL).
   */
  async sendEmail({ to, subject, html, attachments = [], entrepriseId, factureId, userId, typeEmail = 'facture' }) {
    let historyRecord = null;
    if (entrepriseId) {
      try {
        [historyRecord] = await db.insert(historiqueEmails).values({
          entrepriseId,
          factureId,
          destinataire: to,
          sujet: subject,
          typeEmail,
          statut: 'en_attente',
          envoyePar: userId,
        }).returning();
      } catch (historyError) {
        console.error('Erreur lors de la création de l’historique e-mail:', historyError);
      }
    }

    const failHistory = async (messageErreur) => {
      if (!historyRecord) return;
      try {
        await db.update(historiqueEmails)
          .set({ statut: 'echec', messageErreur })
          .where(eq(historiqueEmails.id, historyRecord.id));
      } catch (updateError) {
        console.error('Erreur lors de la mise à jour de l\'historique (échec):', updateError);
      }
    };

    if (!this.enabled) {
      console.warn('⚠️ MAKE_WEBHOOK_URL non configurée - Email NON ENVOYÉ à', to);
      await failHistory('MAKE_WEBHOOK_URL non configurée - Envoi impossible');
      return {
        success: false,
        message: 'Envoi d’e-mail indisponible pour le moment. Réessayez plus tard.',
        error: 'MAKE_WEBHOOK_URL non configurée',
      };
    }

    // Le webhook Make ne transporte pas de pièces jointes (to/subject/
    // message uniquement) : l'e-mail part sans elles, avec un avertissement
    // journalisé. Les factures PDF restent téléchargeables dans l'application.
    if (attachments.length > 0) {
      console.warn(`⚠️ ${attachments.length} pièce(s) jointe(s) non transmise(s) par le webhook Make (e-mail à ${to}).`);
    }

    const result = await this.postToWebhook({ to, subject, message: html });
    if (!result.success) {
      console.error('❌ Erreur lors de l\'envoi de l\'email via Make:', result.error);
      await failHistory(result.error);
      return { success: false, message: 'Erreur lors de l\'envoi de l\'email', error: result.error };
    }

    if (historyRecord) {
      try {
        await db.update(historiqueEmails)
          .set({ statut: 'envoye' })
          .where(eq(historiqueEmails.id, historyRecord.id));
      } catch (updateError) {
        console.error('Erreur lors de la mise à jour de l\'historique (succès):', updateError);
      }
    }
    console.log(`✅ Email envoyé avec succès à ${to} (via Make)`);
    return {
      success: true,
      message: 'Email envoyé avec succès',
      warning: attachments.length > 0 ? 'Pièces jointes non transmises par le webhook Make.' : undefined,
    };
  }

  /**
   * Code de vérification d'e-mail à 6 chiffres (28 nov. 2026).
   * Le code n'est jamais journalisé et jamais persisté en clair.
   */
  async sendVerificationCodeEmail({ to, code, nomEntreprise, entrepriseId, userId, isFedapay = false }) {
    const appUrl = process.env.FRONTEND_URL || 'https://lite.comptaorion.com';
    const subject = 'ComptaOrioLite — Votre code de vérification';
    const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Code de vérification ComptaOrioLite</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="background-color:#3157a4;padding:30px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;">ComptaOrioLite</h1>
        </td></tr>
        <tr><td style="padding:40px 30px;">
          <h2 style="color:#333333;margin-top:0;">Bonjour${nomEntreprise ? ` ${nomEntreprise}` : ''},</h2>
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Pour activer votre compte ComptaOrioLite, saisissez ce code de vérification :
          </p>
          <p style="text-align:center;font-size:36px;font-weight:800;letter-spacing:8px;color:#3157a4;margin:28px 0;">${code}</p>
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Ce code est valable <strong>15 minutes</strong> et ne peut être utilisé qu’une fois.
            Après 5 tentatives incorrectes, le code est invalidé et un nouveau code doit être demandé.
          </p>
          ${isFedapay ? `<p style="color:#666666;font-size:16px;line-height:1.6;">Votre compte est créé. Pour définir votre mot de passe, utilisez « Mot de passe oublié » sur la page de connexion.</p>` : ''}
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Une fois votre adresse vérifiée, votre essai gratuit de 30 jours démarre.
            Vous pourrez alors vous connecter avec votre adresse e-mail et votre mot de passe.
          </p>
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.
          </p>
          <p style="color:#666666;font-size:16px;line-height:1.6;margin-bottom:0;">
            Cordialement,<br><strong>L’équipe ComptaOrioLite</strong><br>
            <a href="${appUrl}">${appUrl}</a> · admin@orionexa.net
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
    `.trim();
    return this.sendEmail({
      to, subject, html, entrepriseId, userId, typeEmail: 'verification',
    });
  }

  /** Lien de réinitialisation de mot de passe (valable 1 heure). */
  async sendPasswordResetEmail({ to, resetLink, nomEntreprise, entrepriseId, userId }) {
    const subject = 'ComptaOrioLite — Réinitialisation de votre mot de passe';
    const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Réinitialisation du mot de passe ComptaOrioLite</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="background-color:#3157a4;padding:30px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;">ComptaOrioLite</h1>
        </td></tr>
        <tr><td style="padding:40px 30px;">
          <h2 style="color:#333333;margin-top:0;">Bonjour${nomEntreprise ? ` ${nomEntreprise}` : ''},</h2>
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Vous avez demandé la réinitialisation de votre mot de passe ComptaOrioLite.
            Cliquez sur le lien ci-dessous (valable 1 heure) :
          </p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${resetLink}" style="display:inline-block;background:#3157a4;color:#ffffff;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;">Réinitialiser mon mot de passe</a>
          </p>
          <p style="color:#666666;font-size:14px;line-height:1.6;">
            Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
            ${resetLink}
          </p>
          <p style="color:#666666;font-size:16px;line-height:1.6;">
            Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.
          </p>
          <p style="color:#666666;font-size:16px;line-height:1.6;margin-bottom:0;">
            Cordialement,<br><strong>L’équipe ComptaOrioLite</strong><br>admin@orionexa.net
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
    `.trim();
    return this.sendEmail({
      to, subject, html, entrepriseId, userId, typeEmail: 'reinitialisation',
    });
  }

  /**
   * Envoie une facture par email
   */
  async sendInvoiceEmail({
    facture,
    client,
    entreprise,
    pdfBase64,
    userId
  }) {
    const subject = `Facture ${facture.numeroFacture} - ${entreprise.nom}`;
    const html = this.getInvoiceEmailTemplate(facture, client, entreprise);

    const attachments = pdfBase64 ? [{
      content: pdfBase64,
      filename: `Facture_${facture.numeroFacture}.pdf`,
      type: 'application/pdf',
    }] : [];

    return this.sendEmail({
      to: client.email,
      subject,
      html,
      attachments,
      entrepriseId: entreprise.id,
      factureId: facture.id,
      userId,
      typeEmail: 'facture',
    });
  }

  /**
   * Template HTML pour les factures
   */
  getInvoiceEmailTemplate(facture, client, entreprise) {
    const couleurPrincipale = entreprise.factureCouleurPrincipale || '#3498db';
    const devise = entreprise.devise || 'FCFA';
    const symboleDevise = entreprise.symboleDevise || devise;
    const montantTotal = facture.totalTTC || facture.montantTotal || 0;

    const montantFormate = `${new Intl.NumberFormat('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(montantTotal)} ${symboleDevise}`;

    return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Facture ${facture.numeroFacture}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

          <!-- En-tête -->
          <tr>
            <td style="background-color: ${couleurPrincipale}; padding: 30px; text-align: center;">
              ${entreprise.logoUrl ? `<img src="${entreprise.logoUrl}" alt="${entreprise.nom}" style="max-width: 150px; margin-bottom: 15px;">` : ''}
              <h1 style="color: #ffffff; margin: 0; font-size: 28px;">${entreprise.nom}</h1>
            </td>
          </tr>

          <!-- Corps du message -->
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="color: #333333; margin-top: 0;">Bonjour ${client.nom},</h2>

              <p style="color: #666666; font-size: 16px; line-height: 1.6;">
                Veuillez trouver ci-joint votre facture <strong>${facture.numeroFacture}</strong>
                d'un montant de <strong style="color: ${couleurPrincipale};">${montantFormate}</strong>.
              </p>

              <table width="100%" cellpadding="15" cellspacing="0" style="margin: 30px 0; background-color: #f8f9fa; border-radius: 6px;">
                <tr>
                  <td style="border-bottom: 1px solid #dee2e6;">
                    <strong style="color: #333333;">Numéro de facture :</strong>
                  </td>
                  <td style="text-align: right; border-bottom: 1px solid #dee2e6;">
                    ${facture.numeroFacture}
                  </td>
                </tr>
                <tr>
                  <td style="border-bottom: 1px solid #dee2e6;">
                    <strong style="color: #333333;">Date d'émission :</strong>
                  </td>
                  <td style="text-align: right; border-bottom: 1px solid #dee2e6;">
                    ${new Date(facture.dateFacture).toLocaleDateString('fr-FR')}
                  </td>
                </tr>
                <tr>
                  <td style="border-bottom: 1px solid #dee2e6;">
                    <strong style="color: #333333;">Date d'échéance :</strong>
                  </td>
                  <td style="text-align: right; border-bottom: 1px solid #dee2e6;">
                    ${facture.dateEcheance ? new Date(facture.dateEcheance).toLocaleDateString('fr-FR') : 'Non spécifiée'}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong style="color: #333333;">Montant total :</strong>
                  </td>
                  <td style="text-align: right;">
                    <strong style="color: ${couleurPrincipale}; font-size: 18px;">${montantFormate}</strong>
                  </td>
                </tr>
              </table>

              <p style="color: #666666; font-size: 16px; line-height: 1.6;">
                Pour toute question concernant cette facture, n'hésitez pas à nous contacter.
              </p>

              <p style="color: #666666; font-size: 16px; line-height: 1.6; margin-bottom: 0;">
                Cordialement,<br>
                <strong>${entreprise.nom}</strong>
              </p>
            </td>
          </tr>

          <!-- Pied de page -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px 30px; text-align: center; border-top: 1px solid #dee2e6;">
              <p style="color: #666666; font-size: 14px; margin: 5px 0;">
                ${entreprise.nom}
              </p>
              ${entreprise.adresse ? `<p style="color: #999999; font-size: 12px; margin: 5px 0;">${entreprise.adresse}</p>` : ''}
              ${entreprise.telephone ? `<p style="color: #999999; font-size: 12px; margin: 5px 0;">Tél: ${entreprise.telephone}</p>` : ''}
              ${entreprise.email ? `<p style="color: #999999; font-size: 12px; margin: 5px 0;">Email: ${entreprise.email}</p>` : ''}
              ${entreprise.factureFooterText ? `<p style="color: #999999; font-size: 12px; margin: 15px 0 5px 0; font-style: italic;">${entreprise.factureFooterText}</p>` : ''}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }
}

export default new EmailService();
