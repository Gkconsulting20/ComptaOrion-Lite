import express from 'express';
import { db } from '../db.js';
import { immobilisations } from '../schema.js';
import { eq } from 'drizzle-orm';

const router = express.Router();

// Export registre immobilisations en JSON/CSV
router.get('/export-registre', async (req, res) => {
  try {
    const { entrepriseId, format = 'json' } = req.query;
    const eId = parseInt(entrepriseId);

    const registre = await db.query.immobilisations.findMany({
      where: eq(immobilisations.entrepriseId, eId)
    });

    if (format === 'csv') {
      // Convertir en CSV
      const headers = 'Référence,Description,Date Acquisition,Valeur Acquisition,Amortissement Cumulé,VNC,Statut,Date Cession\n';
      const rows = registre.map(immo => 
        `"${immo.reference}","${immo.description}","${immo.dateAcquisition}","${immo.valeurAcquisition}","${immo.amortissementCumule}","${immo.valeurNetteComptable}","${immo.statut}","${immo.dateCession || ''}"`
      ).join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="registre-immobilisations.csv"');
      res.send(headers + rows);
    } else {
      // JSON par défaut
      res.json({
        titre: 'Registre Immobilisations',
        dateExport: new Date(),
        donnees: registre
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
