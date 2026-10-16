import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Clés secrètes OBLIGATOIRES - Pas de fallback pour sécurité maximale
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  console.error('❌ ERREUR FATALE: JWT_SECRET et JWT_REFRESH_SECRET doivent être définis.');
  console.error('❌ Définir ces variables d\'environnement avant de démarrer le serveur.');
  console.error('❌ Exemple: JWT_SECRET=votre_secret_super_securise');
  process.exit(1); // Arrêter le serveur si les secrets ne sont pas configurés
}

const JWT_EXPIRES_IN = '24h';
const REFRESH_EXPIRES_IN = '7d';

/**
 * Génère un token JWT pour un utilisateur
 */
export function generateToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    entrepriseId: user.entrepriseId,
  };
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Génère un refresh token
 */
export function generateRefreshToken(user) {
  const payload = {
    id: user.id,
    entrepriseId: user.entrepriseId,
  };
  
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN });
}

/**
 * Vérifie un token JWT
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Vérifie un refresh token
 */
export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Hash un mot de passe
 */
export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compare un mot de passe avec son hash
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Middleware d'authentification
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }
  
  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  
  if (!decoded) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
  
  // Ajouter les infos utilisateur à la requête
  req.user = decoded;
  next();
}

/**
 * Middleware pour vérifier les permissions (RBAC)
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissions insuffisantes' });
    }
    
    next();
  };
}

/**
 * Middleware pour isoler les données par entreprise (Row Level Security)
 */
export function entrepriseIsolation(req, res, next) {
  if (!req.user || !req.user.entrepriseId) {
    return res.status(401).json({ error: 'Entreprise non identifiée' });
  }
  
  // Ajouter l'entrepriseId et userId aux données pour toutes les requêtes
  req.entrepriseId = req.user.entrepriseId;
  req.userId = req.user.id;
  next();
}

/**
 * Middleware pour routes SaaS Admin - nécessite role admin et bypass entrepriseIsolation
 */
export function saasAdminOnly(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  
  // Vérifier que l'utilisateur a le rôle admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
  }
  
  next();
}
