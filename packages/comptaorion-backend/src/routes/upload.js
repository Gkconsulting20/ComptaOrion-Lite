import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { db } from '../db.js';
import { entreprises } from '../schema.js';
import { eq } from 'drizzle-orm';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadsDir = path.join(__dirname, '../../uploads/logos');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    if (!req.entrepriseId) {
      return cb(new Error('Entreprise ID manquant - authentification requise'));
    }
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `entreprise-${req.entrepriseId}-logo-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

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
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }

    const logoUrl = `/uploads/logos/${req.file.filename}`;

    const [entreprise] = await db.select()
      .from(entreprises)
      .where(eq(entreprises.id, req.entrepriseId))
      .limit(1);

    if (entreprise?.logoUrl) {
      const oldLogoPath = path.join(__dirname, '../..', entreprise.logoUrl);
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }

    await db.update(entreprises)
      .set({ 
        logoUrl,
        updatedAt: new Date()
      })
      .where(eq(entreprises.id, req.entrepriseId));

    res.json({ 
      message: 'Logo uploadé avec succès', 
      logoUrl 
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
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

    if (entreprise.logoUrl) {
      const logoPath = path.join(__dirname, '../..', entreprise.logoUrl);
      if (fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
      }
    }

    await db.update(entreprises)
      .set({ 
        logoUrl: null,
        updatedAt: new Date()
      })
      .where(eq(entreprises.id, req.entrepriseId));

    res.json({ message: 'Logo supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
