import { db } from '../db.js';
import { auditLogs } from '../schema.js';

/**
 * Enregistre une action dans le journal d'audit
 * @param {Object} params - Paramètres de l'audit
 * @param {number} params.entrepriseId - ID de l'entreprise
 * @param {number} params.userId - ID de l'utilisateur
 * @param {string} params.action - Action effectuée (CREATE, UPDATE, DELETE, etc.)
 * @param {string} params.table - Nom de la table modifiée
 * @param {number} params.recordId - ID de l'enregistrement modifié
 * @param {Object} params.ancienneValeur - Ancienne valeur (pour UPDATE/DELETE)
 * @param {Object} params.nouvelleValeur - Nouvelle valeur (pour CREATE/UPDATE)
 * @param {string} params.description - Description de l'action
 * @param {string} params.ipAddress - Adresse IP de l'utilisateur
 * @param {string} params.userAgent - User agent du navigateur
 */
export async function logAudit({
  entrepriseId,
  userId = 1, // ID par défaut si pas d'auth
  action,
  table,
  recordId,
  ancienneValeur = null,
  nouvelleValeur = null,
  description,
  ipAddress = null,
  userAgent = null
}) {
  try {
    await db.insert(auditLogs).values({
      entrepriseId: parseInt(entrepriseId),
      userId: userId ? parseInt(userId) : 1,
      action,
      tableName: table,
      recordId: recordId ? parseInt(recordId) : null,
      ancienneValeur: ancienneValeur ? JSON.stringify(ancienneValeur) : null,
      nouvelleValeur: nouvelleValeur ? JSON.stringify(nouvelleValeur) : null,
      description,
      ipAddress,
      userAgent
    });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement de l\'audit:', error);
  }
}

/**
 * Extrait les informations de la requête pour l'audit
 * @param {Object} req - Objet requête Express
 * @returns {Object} Informations pour l'audit
 */
export function extractAuditInfo(req) {
  return {
    entrepriseId: req.entrepriseId || req.query.entrepriseId || req.body.entrepriseId || 1,
    userId: req.user?.id || req.body.userId || 1,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null
  };
}
