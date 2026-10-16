import express from 'express';
import multer from 'multer';
import readXlsxFile from 'read-excel-file/node';
import { db } from '../db.js';
import { 
  importBatches, importRecords, importMappingTemplates,
  clients, fournisseurs, comptesComptables, produits, factures, factureItems, paiements, ecritures, lignesEcritures
} from '../schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { logAudit, extractAuditInfo } from '../utils/auditLogger.js';

const router = express.Router();

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const SUPPORTED_SOURCES = [
  { id: 'quickbooks', name: 'QuickBooks', formats: ['csv', 'xlsx', 'iif'] },
  { id: 'sage100', name: 'Sage 100', formats: ['csv', 'xlsx'] },
  { id: 'excel', name: 'Excel / CSV Générique', formats: ['csv', 'xlsx'] }
];

const ENTITY_TYPES = [
  { id: 'clients', name: 'Clients', champsRequis: ['nom'], champsOptionnels: ['email', 'telephone', 'adresse', 'ville', 'pays', 'numeroTva'] },
  { id: 'fournisseurs', name: 'Fournisseurs', champsRequis: ['raisonSociale'], champsOptionnels: ['email', 'telephone', 'adresse', 'ville', 'pays'] },
  { id: 'plan_comptable', name: 'Plan Comptable', champsRequis: ['numeroCompte', 'libelle'], champsOptionnels: ['typeCompte', 'classe'] },
  { id: 'produits', name: 'Produits/Services', champsRequis: ['nom'], champsOptionnels: ['description', 'prixVente', 'prixAchat', 'tva', 'reference'] },
  { id: 'factures', name: 'Factures Clients', champsRequis: ['numeroFacture', 'clientId', 'montantTotal'], champsOptionnels: ['dateFacture', 'dateEcheance', 'statut'] },
  { id: 'ecritures', name: 'Écritures Comptables', champsRequis: ['dateEcriture', 'libelle'], champsOptionnels: ['journal', 'reference'] }
];

router.get('/sources', (req, res) => {
  res.json({ success: true, data: SUPPORTED_SOURCES });
});

router.get('/entity-types', (req, res) => {
  res.json({ success: true, data: ENTITY_TYPES });
});

router.get('/batches', async (req, res) => {
  try {
    const batches = await db.select()
      .from(importBatches)
      .where(eq(importBatches.entrepriseId, req.entrepriseId))
      .orderBy(desc(importBatches.createdAt))
      .limit(50);
    
    res.json({ success: true, data: batches });
  } catch (error) {
    console.error('Erreur GET /api/import/batches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function parseCSV(buffer, delimiter = ',') {
  const content = buffer.toString('utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  
  if (lines.length === 0) return { headers: [], rows: [] };
  
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push({ ligne: i + 1, data: row });
  }
  
  return { headers, rows };
}

async function parseExcel(buffer) {
  const jsonData = await readXlsxFile(buffer);
  
  if (jsonData.length === 0) return { headers: [], rows: [] };
  
  const headers = jsonData[0].map(h => String(h || '').trim());
  const rows = [];
  
  for (let i = 1; i < jsonData.length; i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = jsonData[i][idx] !== undefined ? String(jsonData[i][idx]) : '';
    });
    if (Object.values(row).some(v => v !== '')) {
      rows.push({ ligne: i + 1, data: row });
    }
  }
  
  return { headers, rows };
}

function parseIIF(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.split(/\r?\n/);
  
  const sections = {};
  let currentSection = null;
  let currentHeaders = [];
  
  for (const line of lines) {
    if (line.startsWith('!')) {
      const parts = line.substring(1).split('\t');
      currentSection = parts[0];
      currentHeaders = parts.slice(1);
      sections[currentSection] = { headers: currentHeaders, rows: [] };
    } else if (currentSection && line.trim()) {
      const values = line.split('\t');
      const sectionType = values[0];
      if (sectionType === currentSection) {
        const row = {};
        currentHeaders.forEach((h, idx) => {
          row[h] = values[idx + 1] || '';
        });
        sections[currentSection].rows.push({ ligne: sections[currentSection].rows.length + 2, data: row });
      }
    }
  }
  
  const mainSection = Object.keys(sections)[0];
  if (mainSection) {
    return { 
      headers: sections[mainSection].headers, 
      rows: sections[mainSection].rows,
      allSections: sections
    };
  }
  
  return { headers: [], rows: [] };
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Aucun fichier fourni' });
    }
    
    const { sourceLogiciel, typeEntite } = req.body;
    
    if (!sourceLogiciel || !typeEntite) {
      return res.status(400).json({ success: false, error: 'Source et type d\'entité requis' });
    }
    
    const fileName = req.file.originalname;
    const ext = fileName.split('.').pop().toLowerCase();
    
    let parsed;
    if (ext === 'csv') {
      const delimiter = req.body.delimiter || (sourceLogiciel === 'sage100' ? ';' : ',');
      parsed = parseCSV(req.file.buffer, delimiter);
    } else if (ext === 'xlsx' || ext === 'xls') {
      parsed = await parseExcel(req.file.buffer);
    } else if (ext === 'iif') {
      parsed = parseIIF(req.file.buffer);
    } else {
      return res.status(400).json({ success: false, error: 'Format de fichier non supporté. Utilisez CSV, Excel ou IIF.' });
    }
    
    if (parsed.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Le fichier est vide ou n\'a pas pu être lu' });
    }
    
    const [batch] = await db.insert(importBatches).values({
      entrepriseId: req.entrepriseId,
      userId: req.userId,
      sourceLogiciel,
      formatFichier: ext,
      nomFichier: fileName,
      tailleFichier: req.file.size,
      typeEntite,
      nombreLignesTotal: parsed.rows.length,
      statut: 'brouillon'
    }).returning();
    
    for (const row of parsed.rows) {
      await db.insert(importRecords).values({
        batchId: batch.id,
        ligneFichier: row.ligne,
        donneesOriginales: row.data,
        statut: 'en_attente'
      });
    }
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'IMPORT_UPLOAD',
      table: 'import_batches',
      recordId: batch.id,
      newValues: { sourceLogiciel, typeEntite, nomFichier: fileName, lignes: parsed.rows.length }
    });
    
    res.json({ 
      success: true, 
      data: {
        batchId: batch.id,
        headers: parsed.headers,
        previewRows: parsed.rows.slice(0, 10),
        totalRows: parsed.rows.length,
        allSections: parsed.allSections
      }
    });
  } catch (error) {
    console.error('Erreur POST /api/import/upload:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [batch] = await db.select()
      .from(importBatches)
      .where(and(
        eq(importBatches.id, parseInt(id)),
        eq(importBatches.entrepriseId, req.entrepriseId)
      ));
    
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Import non trouvé' });
    }
    
    const records = await db.select()
      .from(importRecords)
      .where(eq(importRecords.batchId, parseInt(id)))
      .orderBy(importRecords.ligneFichier);
    
    const headers = records.length > 0 ? Object.keys(records[0].donneesOriginales) : [];
    
    res.json({ 
      success: true, 
      data: { 
        batch, 
        records: records.slice(0, 100),
        totalRecords: records.length,
        headers
      }
    });
  } catch (error) {
    console.error('Erreur GET /api/import/batches/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/batches/:id/mapping', async (req, res) => {
  try {
    const { id } = req.params;
    const { mappingColonnes, optionsImport } = req.body;
    
    const [batch] = await db.select()
      .from(importBatches)
      .where(and(
        eq(importBatches.id, parseInt(id)),
        eq(importBatches.entrepriseId, req.entrepriseId)
      ));
    
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Import non trouvé' });
    }
    
    await db.update(importBatches)
      .set({ 
        mappingColonnes: JSON.stringify(mappingColonnes),
        optionsImport: JSON.stringify(optionsImport || {}),
        updatedAt: new Date()
      })
      .where(eq(importBatches.id, parseInt(id)));
    
    res.json({ success: true, message: 'Mapping enregistré' });
  } catch (error) {
    console.error('Erreur POST /api/import/batches/:id/mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/batches/:id/validate', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [batch] = await db.select()
      .from(importBatches)
      .where(and(
        eq(importBatches.id, parseInt(id)),
        eq(importBatches.entrepriseId, req.entrepriseId)
      ));
    
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Import non trouvé' });
    }
    
    if (!batch.mappingColonnes) {
      return res.status(400).json({ success: false, error: 'Le mapping des colonnes doit être configuré avant la validation' });
    }
    
    const mapping = typeof batch.mappingColonnes === 'string' 
      ? JSON.parse(batch.mappingColonnes) 
      : batch.mappingColonnes;
    
    const entityType = ENTITY_TYPES.find(e => e.id === batch.typeEntite);
    const champsRequis = entityType?.champsRequis || [];
    
    const records = await db.select()
      .from(importRecords)
      .where(eq(importRecords.batchId, parseInt(id)));
    
    let valides = 0;
    let erreurs = 0;
    
    for (const record of records) {
      const donnees = record.donneesOriginales;
      const donneesTransformees = {};
      const erreursValidation = [];
      
      for (const [colonneSource, champDest] of Object.entries(mapping)) {
        if (champDest && donnees[colonneSource] !== undefined) {
          donneesTransformees[champDest] = donnees[colonneSource];
        }
      }
      
      for (const champ of champsRequis) {
        if (!donneesTransformees[champ] || donneesTransformees[champ].trim() === '') {
          erreursValidation.push({ champ, message: `Le champ "${champ}" est requis` });
        }
      }
      
      const estValide = erreursValidation.length === 0;
      
      await db.update(importRecords)
        .set({
          donneesTransformees: JSON.stringify(donneesTransformees),
          erreursValidation: erreursValidation.length > 0 ? JSON.stringify(erreursValidation) : null,
          estValide,
          statut: estValide ? 'valide' : 'erreur'
        })
        .where(eq(importRecords.id, record.id));
      
      if (estValide) valides++;
      else erreurs++;
    }
    
    await db.update(importBatches)
      .set({
        nombreLignesValides: valides,
        nombreLignesErreurs: erreurs,
        statut: 'validation',
        updatedAt: new Date()
      })
      .where(eq(importBatches.id, parseInt(id)));
    
    res.json({ 
      success: true, 
      data: { valides, erreurs, total: records.length }
    });
  } catch (error) {
    console.error('Erreur POST /api/import/batches/:id/validate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/batches/:id/commit', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [batch] = await db.select()
      .from(importBatches)
      .where(and(
        eq(importBatches.id, parseInt(id)),
        eq(importBatches.entrepriseId, req.entrepriseId)
      ));
    
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Import non trouvé' });
    }
    
    if (batch.statut !== 'validation') {
      return res.status(400).json({ success: false, error: 'L\'import doit être validé avant le commit' });
    }
    
    await db.update(importBatches)
      .set({ statut: 'en_cours', demarreAt: new Date() })
      .where(eq(importBatches.id, parseInt(id)));
    
    const records = await db.select()
      .from(importRecords)
      .where(and(
        eq(importRecords.batchId, parseInt(id)),
        eq(importRecords.estValide, true)
      ));
    
    let importes = 0;
    const errors = [];
    
    for (const record of records) {
      try {
        const donnees = typeof record.donneesTransformees === 'string'
          ? JSON.parse(record.donneesTransformees)
          : record.donneesTransformees;
        
        let entiteCreee;
        
        switch (batch.typeEntite) {
          case 'clients':
            [entiteCreee] = await db.insert(clients).values({
              entrepriseId: req.entrepriseId,
              nom: donnees.nom,
              email: donnees.email || null,
              telephone: donnees.telephone || null,
              adresse: donnees.adresse || null,
              ville: donnees.ville || null,
              pays: donnees.pays || 'Côte d\'Ivoire'
            }).returning();
            break;
            
          case 'fournisseurs':
            [entiteCreee] = await db.insert(fournisseurs).values({
              entrepriseId: req.entrepriseId,
              raisonSociale: donnees.raisonSociale,
              email: donnees.email || null,
              telephone: donnees.telephone || null,
              adresse: donnees.adresse || null,
              ville: donnees.ville || null,
              pays: donnees.pays || 'Côte d\'Ivoire'
            }).returning();
            break;
            
          case 'plan_comptable':
            [entiteCreee] = await db.insert(comptesComptables).values({
              entrepriseId: req.entrepriseId,
              numeroCompte: donnees.numeroCompte,
              libelle: donnees.libelle,
              typeCompte: donnees.typeCompte || 'actif',
              classe: donnees.classe ? parseInt(donnees.classe) : parseInt(donnees.numeroCompte.charAt(0))
            }).returning();
            break;
            
          case 'produits':
            [entiteCreee] = await db.insert(produits).values({
              entrepriseId: req.entrepriseId,
              nom: donnees.nom,
              description: donnees.description || null,
              prixVente: donnees.prixVente ? parseFloat(donnees.prixVente) : 0,
              prixAchat: donnees.prixAchat ? parseFloat(donnees.prixAchat) : 0,
              tauxTva: donnees.tva ? parseFloat(donnees.tva) : 18,
              reference: donnees.reference || null
            }).returning();
            break;
            
          default:
            throw new Error(`Type d'entité non supporté: ${batch.typeEntite}`);
        }
        
        await db.update(importRecords)
          .set({
            entiteCreeeId: entiteCreee.id,
            entiteCreeeType: batch.typeEntite,
            statut: 'importe'
          })
          .where(eq(importRecords.id, record.id));
        
        importes++;
      } catch (err) {
        errors.push({ ligne: record.ligneFichier, erreur: err.message });
        await db.update(importRecords)
          .set({ statut: 'erreur', erreursValidation: JSON.stringify([{ message: err.message }]) })
          .where(eq(importRecords.id, record.id));
      }
    }
    
    const statut = errors.length === 0 ? 'termine' : (importes > 0 ? 'termine' : 'echec');
    
    await db.update(importBatches)
      .set({
        nombreLignesImportees: importes,
        nombreLignesErreurs: batch.nombreLignesErreurs + errors.length,
        statut,
        termineAt: new Date(),
        messageErreur: errors.length > 0 ? `${errors.length} erreurs lors de l'import` : null
      })
      .where(eq(importBatches.id, parseInt(id)));
    
    await logAudit({
      ...extractAuditInfo(req),
      action: 'IMPORT_COMMIT',
      table: 'import_batches',
      recordId: parseInt(id),
      newValues: { importes, erreurs: errors.length, typeEntite: batch.typeEntite }
    });
    
    res.json({ 
      success: true, 
      data: { importes, erreurs: errors, total: records.length }
    });
  } catch (error) {
    console.error('Erreur POST /api/import/batches/:id/commit:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/batches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [batch] = await db.select({ id: importBatches.id })
      .from(importBatches)
      .where(and(
        eq(importBatches.id, parseInt(id)),
        eq(importBatches.entrepriseId, req.entrepriseId)
      ));
    
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Import non trouvé' });
    }
    
    await db.delete(importRecords)
      .where(eq(importRecords.batchId, parseInt(id)));
    
    await db.delete(importBatches)
      .where(eq(importBatches.id, parseInt(id)));
    
    res.json({ success: true, message: 'Import supprimé' });
  } catch (error) {
    console.error('Erreur DELETE /api/import/batches/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const templates = await db.select()
      .from(importMappingTemplates)
      .where(eq(importMappingTemplates.actif, true))
      .orderBy(desc(importMappingTemplates.estSysteme), desc(importMappingTemplates.createdAt));
    
    res.json({ success: true, data: templates });
  } catch (error) {
    console.error('Erreur GET /api/import/templates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
