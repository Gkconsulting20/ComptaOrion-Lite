import express from 'express';
import { db } from '../db.js';
import { auditLogs } from '../schema.js';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';

const router = express.Router();

// GET /api/audit-logs - Récupérer les logs d'audit avec filtres
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      table,
      userId,
      dateDebut,
      dateFin
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Construction des conditions WHERE
    let whereConditions = [eq(auditLogs.entrepriseId, req.entrepriseId)];

    if (action) {
      whereConditions.push(eq(auditLogs.action, action));
    }

    if (table) {
      whereConditions.push(eq(auditLogs.tableName, table));
    }

    if (userId) {
      whereConditions.push(eq(auditLogs.userId, parseInt(userId)));
    }

    if (dateDebut) {
      whereConditions.push(gte(auditLogs.createdAt, new Date(dateDebut)));
    }

    if (dateFin) {
      whereConditions.push(lte(auditLogs.createdAt, new Date(dateFin)));
    }

    // Récupérer les logs
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(...whereConditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(parseInt(limit))
      .offset(offset);

    // Compter le total
    const [{ count }] = await db
      .select({ count: sql`count(*)::int` })
      .from(auditLogs)
      .where(and(...whereConditions));

    return res.json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Erreur récupération audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des logs d\'audit',
      error: error.message
    });
  }
});

// GET /api/audit-logs/stats - Statistiques des logs d'audit
router.get('/stats', async (req, res) => {
  try {
    const { dateDebut, dateFin } = req.query;

    let whereConditions = [eq(auditLogs.entrepriseId, req.entrepriseId)];

    if (dateDebut) {
      whereConditions.push(gte(auditLogs.createdAt, new Date(dateDebut)));
    }

    if (dateFin) {
      whereConditions.push(lte(auditLogs.createdAt, new Date(dateFin)));
    }

    // Stats par action
    const statsByAction = await db
      .select({
        action: auditLogs.action,
        count: sql`count(*)::int`
      })
      .from(auditLogs)
      .where(and(...whereConditions))
      .groupBy(auditLogs.action);

    // Stats par table
    const statsByTable = await db
      .select({
        table: auditLogs.tableName,
        count: sql`count(*)::int`
      })
      .from(auditLogs)
      .where(and(...whereConditions))
      .groupBy(auditLogs.tableName);

    return res.json({
      success: true,
      data: {
        byAction: statsByAction,
        byTable: statsByTable
      }
    });
  } catch (error) {
    console.error('Erreur stats audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

export default router;
