import express from 'express';
import multer from 'multer';
import path from 'path';
import { db } from '../db.js';
import { entreprises } from '../schema.js';
import { verifierLimiteStockage } from '../plan-limits.js';
import { eq } from 'drizzle-orm';

const router = express.Router();

// Logo d'entreprise (POST /api/logo, DELETE /api/logo).
//
// Stockage en mémoire puis data URL dans entreprises.logo_url : le
// Worker Cloudflare n'a pas de disque inscriptible (l'ancien
// multer.diskStorage + fs.mkdirSync à l'import faisait échouer le
// démarrage du Worker) et ne sert pas de fichiers statiques — une URL
// /uploads/logos/... n'aurait de toute façon rien servi. La data URL
// est consommée telle quelle par parametres.js et emailService.js
// (<img src={logoUrl}>). Limite 5 Mo par fichier, comme avant.

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|svg/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Seuls les fichiers image (JPEG, PNG, GIF, SVG) sont autorisés'));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }

    // Limite de stockage du forfait actif (403 au-delà — modèle Orion
    // Santé). Le logo est un fichier unique remplacé à chaque envoi :
    // le contrôle porte sur la taille du fichier entrant. L'essai, la
    // démo et le propriétaire de la plateforme ne sont pas limités
    // (voir plan-limits.js).
    try {
      await verifierLimiteStockage(db, req.entrepriseId, req.file.size, req.user);
    } catch (error) {
      if (error.statut === 403) {
        return res.status(403).json({ error: error.message, code: error.code });
      }
      throw error;
    }

    const logoUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    await db.update(entreprises)
      .set({
        logoUrl,
        updatedAt: new Date(),
      })
      .where(eq(entreprises.id, req.entrepriseId));

    res.json({
      message: 'Logo uploadé avec succès',
      logoUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/logo', async (req, res) => {
  try {
    if (!req.entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const [entreprise] = await db.select()
      .from(entreprises)
      .where(eq(entreprises.id, req.entrepriseId))
      .limit(1);

    if (!entreprise) {
      return res.status(404).json({ error: 'Entreprise introuvable' });
    }

    await db.update(entreprises)
      .set({
        logoUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(entreprises.id, req.entrepriseId));

    res.json({ message: 'Logo supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
