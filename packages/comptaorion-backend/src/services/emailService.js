import sgMail from '@sendgrid/mail';
import { db } from '../db.js';
import { historiqueEmails, factures } from '../schema.js';
import { eq, and } from 'drizzle-orm';

class EmailService {
  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️  SENDGRID_API_KEY non configurée - Les emails ne seront pas envoyés');
      this.enabled = false;
    } else {
      sgMail.setApiKey(apiKey);
      this.enabled = true;
      console.log('✅ SendGrid configuré avec succès');
    }
    
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@comptaorion.com';
    this.fromName = process.env.SENDGRID_FROM_NAME || 'ComptaOrion';
  }

  /**
   * Envoie un email via SendGrid
   */
  async sendEmail({ to, subject, html, attachments = [], entrepriseId, factureId, userId, typeEmail = 'facture' }) {
    try {
      const [historyRecord] = await db.insert(historiqueEmails).values({
        entrepriseId,
        factureId,
        destinataire: to,
        sujet: subject,
        typeEmail,
        statut: 'en_attente',
        envoyePar: userId,
      }).returning();

      if (!this.enabled) {
        console.log('📧 [SIMULATION] Email qui serait envoyé:');
        console.log(`   À: ${to}`);
        console.log(`   Sujet: ${subject}`);
        console.log(`   Pièces jointes: ${attachments.length}`);
        
        try {
          await db.update(historiqueEmails)
            .set({
              statut: 'echec',
              messageErreur: 'SendGrid non configuré - Mode simulation',
            })
            .where(eq(historiqueEmails.id, historyRecord.id));
        } catch (updateError) {
          console.error('Erreur lors de la mise à jour de l\'historique (simulation):', updateError);
        }

        return {
          success: false,
          message: 'SendGrid non configuré. Configurez SENDGRID_API_KEY pour envoyer des emails.',
          simulation: true,
        };
      }

      try {
        const msg = {
          to,
          from: {
            email: this.fromEmail,
            name: this.fromName,
          },
          subject,
          html,
          attachments: attachments.map(att => ({
            content: att.content,
            filename: att.filename,
            type: att.type || 'application/pdf',
            disposition: 'attachment',
          })),
        };

        const response = await sgMail.send(msg);
        
        try {
          await db.update(historiqueEmails)
            .set({ statut: 'envoye' })
            .where(eq(historiqueEmails.id, historyRecord.id));
        } catch (updateError) {
          console.error('Erreur lors de la mise à jour de l\'historique (succès):', updateError);
        }

        console.log(`✅ Email envoyé avec succès à ${to}`);
        
        return {
          success: true,
          message: 'Email envoyé avec succès',
          messageId: response[0].headers['x-message-id'],
        };
      } catch (error) {
        console.error('❌ Erreur lors de l\'envoi de l\'email:', error);
        
        try {
          await db.update(historiqueEmails)
            .set({
              statut: 'echec',
              messageErreur: error.message,
            })
            .where(eq(historiqueEmails.id, historyRecord.id));
        } catch (updateError) {
          console.error('Erreur lors de la mise à jour de l\'historique (échec):', updateError);
        }

        return {
          success: false,
          message: 'Erreur lors de l\'envoi de l\'email',
          error: error.message,
        };
      }
    } catch (error) {
      console.error('❌ Erreur critique dans sendEmail:', error);
      return {
        success: false,
        message: 'Erreur lors de l\'initialisation de l\'envoi',
        error: error.message,
      };
    }
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
