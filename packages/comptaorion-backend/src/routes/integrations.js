import express from 'express';
import crypto from 'crypto';
import { db } from '../db.js';
import { 
  apiKeys, webhookSubscriptions, webhookDeliveries, 
  backupConfigs, backupJobs, exportHistory,
  clients, fournisseurs, factures, factureItems, paiements,
  ecritures, lignesEcritures, comptesComptables,
  produits, mouvementsStock, comptesBancaires, transactionsTresorerie,
  employes, depenses
} from '../schema.js';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { logAudit, extractAuditInfo } from '../utils/auditLogger.js';

const router = express.Router();

// ==========================================
// UTILITAIRES
// ==========================================

function generateApiKey() {
  const prefix = 'co_' + crypto.randomBytes(4).toString('hex');
  const key = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { fullKey: `${prefix}_${key}`, prefix, hash };
}

function generateWebhookSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

// Chiffrement symétrique pour les secrets webhook
// En production, WEBHOOK_ENCRYPTION_KEY devrait être défini dans l'environnement
const getEncryptionKey = () => {
  if (process.env.WEBHOOK_ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(process.env.WEBHOOK_ENCRYPTION_KEY).digest();
  }
  // Fallback - génère une clé basée sur DATABASE_URL (recommandé de définir WEBHOOK_ENCRYPTION_KEY en production)
  console.warn('⚠️  WEBHOOK_ENCRYPTION_KEY non défini. Utilisation d\'une clé dérivée.');
  return crypto.createHash('sha256').update(process.env.DATABASE_URL || 'comptaorion-fallback-key').digest();
};
const ENCRYPTION_KEY = getEncryptionKey();

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptSecret(encryptedData) {
  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function signPayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadString = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return { timestamp, signature: `v1=${signature}` };
}

// ==========================================
// CLÉS API
// ==========================================

router.get('/api-keys', async (req, res) => {
  try {
    const keys = await db
      .select({
        id: apiKeys.id,
        nom: apiKeys.nom,
        keyPrefix: apiKeys.keyPrefix,
        permissions: apiKeys.permissions,
        ipAllowlist: apiKeys.ipAllowlist,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        actif: apiKeys.actif,
        createdAt: apiKeys.createdAt
      })
      .from(apiKeys)
      .where(eq(apiKeys.entrepriseId, req.entrepriseId))
      .orderBy(desc(apiKeys.createdAt));
    
    res.json({ success: true, data: keys });
  } catch (error) {
    console.error('Erreur GET /api/integrations/api-keys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api-keys', async (req, res) => {
  try {
    const { nom, permissions = ['read'], ipAllowlist, expiresAt } = req.body;
    
    if (!nom) {
      return res.status(400).json({ success: false, error: 'Le nom est requis' });
    }
    
    const { fullKey, prefix, hash } = generateApiKey();
    
    const [newKey] = await db.insert(apiKeys).values({
      entrepriseId: req.entrepriseId,
      nom,
      keyHash: hash,
      keyPrefix: prefix,
      permissions: JSON.stringify(permissions),
      ipAllowlist: ipAllowlist ? JSON.stringify(ipAllowlist) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: req.userId
    }).returning();
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'CREATE',
      table: 'api_keys',
      recordId: newKey.id,
      newValues: { nom, permissions }
    });
    
    res.json({ 
      success: true, 
      data: { 
        id: newKey.id,
        nom,
        apiKey: fullKey,
        prefix,
        message: 'Conservez cette clé précieusement, elle ne sera plus affichée.'
      }
    });
  } catch (error) {
    console.error('Erreur POST /api/integrations/api-keys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/api-keys/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.delete(apiKeys)
      .where(and(
        eq(apiKeys.id, parseInt(id)),
        eq(apiKeys.entrepriseId, req.entrepriseId)
      ));
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'DELETE',
      table: 'api_keys',
      recordId: parseInt(id)
    });
    
    res.json({ success: true, message: 'Clé API supprimée' });
  } catch (error) {
    console.error('Erreur DELETE /api/integrations/api-keys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/api-keys/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [key] = await db.select().from(apiKeys)
      .where(and(
        eq(apiKeys.id, parseInt(id)),
        eq(apiKeys.entrepriseId, req.entrepriseId)
      ));
    
    if (!key) {
      return res.status(404).json({ success: false, error: 'Clé non trouvée' });
    }
    
    await db.update(apiKeys)
      .set({ actif: !key.actif })
      .where(eq(apiKeys.id, parseInt(id)));
    
    res.json({ success: true, actif: !key.actif });
  } catch (error) {
    console.error('Erreur PUT /api/integrations/api-keys/:id/toggle:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// WEBHOOKS
// ==========================================

const AVAILABLE_EVENTS = [
  'facture.created', 'facture.paid', 'facture.sent',
  'paiement.received', 'paiement.created',
  'client.created', 'client.updated',
  'fournisseur.created', 'fournisseur.updated',
  'ecriture.posted', 'ecriture.validated',
  'stock.alert', 'stock.movement',
  'backup.completed', 'backup.failed'
];

router.get('/webhooks', async (req, res) => {
  try {
    const webhooks = await db.select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.entrepriseId, req.entrepriseId))
      .orderBy(desc(webhookSubscriptions.createdAt));
    
    res.json({ success: true, data: webhooks, availableEvents: AVAILABLE_EVENTS });
  } catch (error) {
    console.error('Erreur GET /api/integrations/webhooks:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/webhooks', async (req, res) => {
  try {
    const { nom, url, evenements = [] } = req.body;
    
    if (!nom || !url) {
      return res.status(400).json({ success: false, error: 'Nom et URL requis' });
    }
    
    const plaintextSecret = generateWebhookSecret();
    const encryptedSecret = encryptSecret(plaintextSecret);
    
    const [webhook] = await db.insert(webhookSubscriptions).values({
      entrepriseId: req.entrepriseId,
      nom,
      url,
      secret: encryptedSecret,
      evenements: JSON.stringify(evenements)
    }).returning();
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'CREATE',
      table: 'webhook_subscriptions',
      recordId: webhook.id,
      newValues: { nom, url, evenements }
    });
    
    // Retourner le secret en clair UNE SEULE FOIS - l'utilisateur doit le sauvegarder
    res.json({ 
      success: true, 
      data: { 
        ...webhook,
        secret: plaintextSecret,
        message: 'IMPORTANT: Conservez ce secret maintenant - il ne sera plus jamais affiché.'
      }
    });
  } catch (error) {
    console.error('Erreur POST /api/integrations/webhooks:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/webhooks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, url, evenements, actif } = req.body;
    
    const updateData = {};
    if (nom) updateData.nom = nom;
    if (url) updateData.url = url;
    if (evenements) updateData.evenements = JSON.stringify(evenements);
    if (typeof actif === 'boolean') updateData.actif = actif;
    updateData.updatedAt = new Date();
    
    await db.update(webhookSubscriptions)
      .set(updateData)
      .where(and(
        eq(webhookSubscriptions.id, parseInt(id)),
        eq(webhookSubscriptions.entrepriseId, req.entrepriseId)
      ));
    
    res.json({ success: true, message: 'Webhook mis à jour' });
  } catch (error) {
    console.error('Erreur PUT /api/integrations/webhooks/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/webhooks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Vérifier que le webhook appartient à cette entreprise AVANT de supprimer
    const [webhook] = await db.select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(and(
        eq(webhookSubscriptions.id, parseInt(id)),
        eq(webhookSubscriptions.entrepriseId, req.entrepriseId)
      ));
    
    if (!webhook) {
      return res.status(404).json({ success: false, error: 'Webhook non trouvé' });
    }
    
    // Supprimer les deliveries liées
    await db.delete(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, parseInt(id)));
    
    // Supprimer le webhook
    await db.delete(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, parseInt(id)));
    
    res.json({ success: true, message: 'Webhook supprimé' });
  } catch (error) {
    console.error('Erreur DELETE /api/integrations/webhooks/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/webhooks/:id/deliveries', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Vérifier que le webhook appartient à cette entreprise
    const [webhook] = await db.select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(and(
        eq(webhookSubscriptions.id, parseInt(id)),
        eq(webhookSubscriptions.entrepriseId, req.entrepriseId)
      ));
    
    if (!webhook) {
      return res.status(404).json({ success: false, error: 'Webhook non trouvé' });
    }
    
    const deliveries = await db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, parseInt(id)))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50);
    
    res.json({ success: true, data: deliveries });
  } catch (error) {
    console.error('Erreur GET /api/integrations/webhooks/:id/deliveries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/webhooks/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [webhook] = await db.select()
      .from(webhookSubscriptions)
      .where(and(
        eq(webhookSubscriptions.id, parseInt(id)),
        eq(webhookSubscriptions.entrepriseId, req.entrepriseId)
      ));
    
    if (!webhook) {
      return res.status(404).json({ success: false, error: 'Webhook non trouvé' });
    }
    
    const testPayload = {
      event: 'test.ping',
      data: { message: 'Test de connexion depuis ComptaOrion', timestamp: new Date().toISOString() }
    };
    
    // Déchiffrer le secret pour signer le payload
    const decryptedSecret = decryptSecret(webhook.secret);
    const { timestamp, signature } = signPayload(testPayload, decryptedSecret);
    
    const startTime = Date.now();
    let response, responseStatus, responseBody, durationMs;
    
    try {
      response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ComptaOrion-Signature': signature,
          'X-ComptaOrion-Timestamp': timestamp.toString()
        },
        body: JSON.stringify(testPayload)
      });
      durationMs = Date.now() - startTime;
      responseStatus = response.status;
      responseBody = await response.text();
    } catch (fetchError) {
      durationMs = Date.now() - startTime;
      responseStatus = 0;
      responseBody = fetchError.message;
    }
    
    await db.insert(webhookDeliveries).values({
      subscriptionId: parseInt(id),
      evenement: 'test.ping',
      payload: testPayload,
      responseStatus,
      responseBody: responseBody.substring(0, 1000),
      durationMs,
      statut: responseStatus >= 200 && responseStatus < 300 ? 'success' : 'failed'
    });
    
    res.json({ 
      success: responseStatus >= 200 && responseStatus < 300,
      data: { responseStatus, durationMs, responseBody: responseBody.substring(0, 500) }
    });
  } catch (error) {
    console.error('Erreur POST /api/integrations/webhooks/:id/test:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// EXPORTS DE DONNÉES
// ==========================================

const DOMAINS = {
  clients: { table: clients, name: 'Clients' },
  fournisseurs: { table: fournisseurs, name: 'Fournisseurs' },
  factures: { table: factures, name: 'Factures' },
  paiements: { table: paiements, name: 'Paiements' },
  ecritures: { table: ecritures, name: 'Écritures Comptables' },
  comptes: { table: comptesComptables, name: 'Plan Comptable' },
  produits: { table: produits, name: 'Produits/Services' },
  mouvements_stock: { table: mouvementsStock, name: 'Mouvements Stock' },
  comptes_bancaires: { table: comptesBancaires, name: 'Comptes Bancaires' },
  transactions: { table: transactionsTresorerie, name: 'Transactions Trésorerie' },
  employes: { table: employes, name: 'Employés' },
  depenses: { table: depenses, name: 'Dépenses' }
};

router.get('/export/domains', async (req, res) => {
  const domainList = Object.entries(DOMAINS).map(([key, val]) => ({
    id: key,
    name: val.name
  }));
  res.json({ success: true, data: domainList });
});

router.get('/export/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const { format = 'json', dateDebut, dateFin } = req.query;
    
    if (!DOMAINS[domain]) {
      return res.status(400).json({ success: false, error: 'Domaine invalide' });
    }
    
    const table = DOMAINS[domain].table;
    let data;
    
    if (table.entrepriseId) {
      data = await db.select().from(table)
        .where(eq(table.entrepriseId, req.entrepriseId))
        .orderBy(desc(table.createdAt || table.id));
    } else {
      data = await db.select().from(table);
    }
    
    await db.insert(exportHistory).values({
      entrepriseId: req.entrepriseId,
      userId: req.userId,
      domaine: domain,
      format,
      filtres: JSON.stringify({ dateDebut, dateFin }),
      nombreEnregistrements: data.length,
      ipAddress: req.ip
    });
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'EXPORT',
      table: domain,
      newValues: { format, count: data.length }
    });
    
    if (format === 'csv') {
      if (data.length === 0) {
        return res.status(200).type('text/csv').send('');
      }
      const headers = Object.keys(data[0]);
      const csvRows = [headers.join(',')];
      data.forEach(row => {
        const values = headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          if (typeof val === 'object') return JSON.stringify(val).replace(/"/g, '""');
          return String(val).replace(/"/g, '""');
        });
        csvRows.push(values.map(v => `"${v}"`).join(','));
      });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${domain}_export_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvRows.join('\n'));
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${domain}_export_${new Date().toISOString().split('T')[0]}.json"`);
    res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      domain: DOMAINS[domain].name,
      count: data.length,
      data
    });
  } catch (error) {
    console.error(`Erreur GET /api/integrations/export/${req.params.domain}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/export-all', async (req, res) => {
  try {
    const { format = 'json' } = req.query;
    const eId = req.entrepriseId;
    
    const fullExport = {
      exportedAt: new Date().toISOString(),
      entrepriseId: eId,
      version: '1.0',
      domains: {}
    };
    
    for (const [key, config] of Object.entries(DOMAINS)) {
      try {
        const table = config.table;
        if (table.entrepriseId) {
          fullExport.domains[key] = await db.select().from(table)
            .where(eq(table.entrepriseId, eId));
        }
      } catch (e) {
        fullExport.domains[key] = [];
      }
    }
    
    await db.insert(exportHistory).values({
      entrepriseId: eId,
      userId: req.userId,
      domaine: 'all',
      format,
      nombreEnregistrements: Object.values(fullExport.domains).reduce((sum, arr) => sum + arr.length, 0),
      ipAddress: req.ip
    });
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'EXPORT',
      table: 'all_domains',
      newValues: { format }
    });
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="comptaorion_backup_${new Date().toISOString().split('T')[0]}.json"`);
    res.json(fullExport);
  } catch (error) {
    console.error('Erreur GET /api/integrations/export-all:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/export-history', async (req, res) => {
  try {
    const history = await db.select()
      .from(exportHistory)
      .where(eq(exportHistory.entrepriseId, req.entrepriseId))
      .orderBy(desc(exportHistory.createdAt))
      .limit(50);
    
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Erreur GET /api/integrations/export-history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// CONFIGURATIONS DE SAUVEGARDE
// ==========================================

router.get('/backup-configs', async (req, res) => {
  try {
    const configs = await db.select()
      .from(backupConfigs)
      .where(eq(backupConfigs.entrepriseId, req.entrepriseId))
      .orderBy(desc(backupConfigs.createdAt));
    
    res.json({ success: true, data: configs });
  } catch (error) {
    console.error('Erreur GET /api/integrations/backup-configs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/backup-configs', async (req, res) => {
  try {
    const { 
      nom, destination, configDestination, format = 'json',
      frequence = 'weekly', heureExecution = '02:00',
      domainesInclus = ['all'], chiffrement = true
    } = req.body;
    
    if (!nom || !destination || !configDestination) {
      return res.status(400).json({ success: false, error: 'Nom, destination et configuration requis' });
    }
    
    const [config] = await db.insert(backupConfigs).values({
      entrepriseId: req.entrepriseId,
      nom,
      destination,
      configDestination: JSON.stringify(configDestination),
      format,
      frequence,
      heureExecution,
      domainesInclus: JSON.stringify(domainesInclus),
      chiffrement
    }).returning();
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'CREATE',
      table: 'backup_configs',
      recordId: config.id,
      newValues: { nom, destination, frequence }
    });
    
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Erreur POST /api/integrations/backup-configs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/backup-configs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.delete(backupConfigs)
      .where(and(
        eq(backupConfigs.id, parseInt(id)),
        eq(backupConfigs.entrepriseId, req.entrepriseId)
      ));
    
    res.json({ success: true, message: 'Configuration supprimée' });
  } catch (error) {
    console.error('Erreur DELETE /api/integrations/backup-configs/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/backup-jobs', async (req, res) => {
  try {
    const jobs = await db.select()
      .from(backupJobs)
      .where(eq(backupJobs.entrepriseId, req.entrepriseId))
      .orderBy(desc(backupJobs.createdAt))
      .limit(20);
    
    res.json({ success: true, data: jobs });
  } catch (error) {
    console.error('Erreur GET /api/integrations/backup-jobs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
