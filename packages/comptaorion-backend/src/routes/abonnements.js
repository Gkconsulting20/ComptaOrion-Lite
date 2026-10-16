import { Router } from 'express';
import { db } from '../db.js';
import { abonnements, plansAbonnement, facturesAbonnement } from '../schema.js';
import { eq } from 'drizzle-orm';

const router = Router();

// GET all subscription plans
router.get('/plans', async (req, res) => {
  try {
    const plans = await db.select().from(plansAbonnement).where(eq(plansAbonnement.actif, true));
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET subscription details for company
router.get('/:entrepriseId', async (req, res) => {
  try {
    const { entrepriseId } = req.params;
    const subscription = await db.select().from(abonnements).where(eq(abonnements.entrepriseId, parseInt(entrepriseId)));
    
    if (!subscription.length) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    res.json(subscription[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET billing invoices
router.get('/:entrepriseId/factures', async (req, res) => {
  try {
    const { entrepriseId } = req.params;
    const invoices = await db.select().from(facturesAbonnement).where(eq(facturesAbonnement.entrepriseId, parseInt(entrepriseId)));
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update subscription
router.patch('/:abonnementId', async (req, res) => {
  try {
    const { abonnementId } = req.params;
    const updates = req.body;
    
    const result = await db.update(abonnements)
      .set(updates)
      .where(eq(abonnements.id, parseInt(abonnementId)))
      .returning();
    
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST cancel subscription
router.post('/:abonnementId/annuler', async (req, res) => {
  try {
    const { abonnementId } = req.params;
    
    const result = await db.update(abonnements)
      .set({ statut: 'annule' })
      .where(eq(abonnements.id, parseInt(abonnementId)))
      .returning();
    
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
