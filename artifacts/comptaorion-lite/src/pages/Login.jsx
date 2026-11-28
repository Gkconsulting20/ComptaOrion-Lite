import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import api from '../api.js';

const initialRegister = {
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
  nom: '',
  prenom: '',
  entrepriseNom: '',
  entrepriseEmail: '',
  entrepriseTelephone: '',
  entrepriseAdresse: '',
  // Taux de TVA choisi à la création (décision Cap, 21 nov. 2026) :
  // 18 % par défaut, 0 % (exonéré) ou taux personnalisé (0 à 100 %).
  tauxTva: 18,
  commercialId: new URLSearchParams(window.location.search).get('ref') || '',
};

export function Login({ onLoginSuccess, initialMessage = '', initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [registerData, setRegisterData] = useState(initialRegister);
  const [tauxTvaChoix, setTauxTvaChoix] = useState('18');
  const [tauxTvaPerso, setTauxTvaPerso] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [error, setError] = useState(initialMessage);
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  // Vérification e-mail par code à 6 chiffres (28 nov. 2026) : après
  // l'inscription, et quand la connexion est refusée avec
  // EMAIL_NOT_VERIFIED. Code valable 15 minutes ; renvoi après 60 s
  // (3 renvois max par heure) ; l'adresse peut être corrigée avant un renvoi.
  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [nouvelEmail, setNouvelEmail] = useState('');
  const [showCorrection, setShowCorrection] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (retryAfter <= 0) return undefined;
    const timer = setTimeout(() => setRetryAfter((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const changeMode = (next) => {
    setMode(next);
    setError('');
    setSuccess('');
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.post('/auth-security/login', formData);
      localStorage.setItem('token', data.token);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('entrepriseId', data.user.entrepriseId);
      if (data.entreprise) localStorage.setItem('entreprise', JSON.stringify(data.entreprise));
      if (data.session?.id) localStorage.setItem('sessionId', data.session.id);
      onLoginSuccess(data.user);
    } catch (requestError) {
      // Compte non vérifié : basculer vers la saisie du code plutôt
      // qu'afficher une simple erreur.
      if (requestError.data?.code === 'EMAIL_NOT_VERIFIED') {
        setVerifyEmail(formData.email);
        setVerifyCode('');
        setError('');
        setSuccess('Votre adresse e-mail n’est pas encore vérifiée. Saisissez le code à 6 chiffres reçu par e-mail.');
        setMode('verify');
        return;
      }
      setError(requestError.message || 'Erreur de connexion');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (!/^\d{6}$/.test(verifyCode.trim())) {
      setError('Saisissez le code à 6 chiffres reçu par e-mail.');
      return;
    }
    setLoading(true);
    try {
      const data = await api.post('/auth/verifier-email', { email: verifyEmail.trim().toLowerCase(), code: verifyCode.trim() });
      localStorage.setItem('token', data.token);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('entrepriseId', data.user.entrepriseId);
      if (data.entreprise) localStorage.setItem('entreprise', JSON.stringify(data.entreprise));
      onLoginSuccess(data.user);
    } catch (requestError) {
      setError(requestError.message || 'Vérification impossible.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setResending(true);
    try {
      const data = await api.post('/auth/renvoyer-code', {
        email: verifyEmail.trim().toLowerCase(),
        ...(nouvelEmail.trim() ? { nouvelEmail: nouvelEmail.trim().toLowerCase() } : {}),
      });
      if (data?.retryAfterSeconds) setRetryAfter(data.retryAfterSeconds);
      else setRetryAfter(60);
      if (nouvelEmail.trim()) {
        setVerifyEmail(nouvelEmail.trim().toLowerCase());
        setNouvelEmail('');
        setShowCorrection(false);
      }
      setSuccess(data?.message || 'Un nouveau code a été envoyé.');
    } catch (requestError) {
      if (requestError.data?.retryAfterSeconds) setRetryAfter(requestError.data.retryAfterSeconds);
      setError(requestError.message || 'Renvoi impossible.');
    } finally {
      setResending(false);
    }
  };

  const handleRegister = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (registerData.password !== registerData.confirmPassword) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }
    if (registerData.password.length < 12) {
      setError('Le mot de passe doit contenir au moins 12 caractères.');
      return;
    }
    // Taux de TVA : 18 % par défaut, 0 % ou taux personnalisé (0 à 100 %).
    let tauxTva = 18;
    if (tauxTvaChoix === '0') {
      tauxTva = 0;
    } else if (tauxTvaChoix === 'personnalise') {
      const parsed = parseFloat(String(tauxTvaPerso).replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        setError('Le taux de TVA personnalisé doit être entre 0 et 100 %.');
        return;
      }
      tauxTva = Math.round(parsed * 100) / 100;
    }
    setLoading(true);
    try {
      const data = await api.post('/auth/register', { ...registerData, tauxTva });
      // Inscription créée mais non vérifiée : aucun jeton n'est retourné.
      // Le compte s'active avec le code à 6 chiffres envoyé par e-mail.
      setVerifyEmail(registerData.email);
      setVerifyCode('');
      setSuccess(data?.message || 'Compte créé. Un code de vérification à 6 chiffres vient d’être envoyé à votre adresse e-mail.');
      setMode('verify');
      setFormData((current) => ({ ...current, email: registerData.email }));
    } catch (requestError) {
      setError(requestError.message || "Erreur lors de l'inscription");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await api.post('/auth-security/forgot-password', { email: resetEmail });
      setSuccess('Un email de réinitialisation a été envoyé à votre adresse.');
    } catch (requestError) {
      setError(requestError.message || 'Erreur lors de la demande');
    } finally {
      setLoading(false);
    }
  };

  // Démo publique : une entreprise fictive seedée, sans compte ni
  // mot de passe. La session est stockée exactement comme après un
  // login (trialEndsAt null : LiteApp ne déconnecte pas la démo).
  const handleDemo = async () => {
    setError('');
    setLoading(true);
    try {
      const data = await api.post('/auth/demo', {});
      localStorage.setItem('token', data.token);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('entrepriseId', data.user.entrepriseId);
      localStorage.setItem('demo', '1');
      if (data.entreprise) localStorage.setItem('entreprise', JSON.stringify(data.entreprise));
      if (data.session?.id) localStorage.setItem('sessionId', data.session.id);
      onLoginSuccess(data.user);
    } catch (requestError) {
      setError(requestError.message || 'Impossible de créer la démonstration');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-orbit auth-orbit-one" aria-hidden="true" />
      <div className="auth-orbit auth-orbit-two" aria-hidden="true" />
      <section className={`auth-panel ${mode === 'register' ? 'auth-panel-register' : ''}`}>
        <aside className="auth-aside">
          <div className="auth-brand-lockup">
            <img src="/logo-comptaorion.png" alt="ComptaOrion" />
            <span>ComptaOrion <b>Lite</b></span>
          </div>
          <div className="auth-aside-copy">
            <span className="auth-kicker">Le comptoir, toujours ouvert</span>
            <h1>Vos ventes.<br />Votre journée.<br /><em>En ordre.</em></h1>
            <p>Enregistrez ventes, paiements et dépenses rapidement, même lorsque le réseau vous laisse tomber.</p>
          </div>
          <div className="auth-aside-foot"><span className="auth-signal" /> Pensé pour avancer, avec ou sans connexion</div>
        </aside>

        <div className="auth-content">
          <div className="auth-mobile-brand"><img src="/logo-comptaorion.png" alt="" /><span>ComptaOrion <b>Lite</b></span></div>
          {mode === 'login' && (
            <form className="auth-form" onSubmit={handleLogin}>
              <div className="auth-heading">
                <span className="auth-kicker">Bon retour</span>
                <h2>Connexion</h2>
                <p>Retrouvez votre activité en un instant.</p>
              </div>
              <Messages error={error} success={success} />
              <label>Email
                <input data-testid="input-email" type="email" autoComplete="email" value={formData.email} onChange={(event) => setFormData({ ...formData, email: event.target.value })} required />
              </label>
              <label>Mot de passe
                <input data-testid="input-password" type="password" autoComplete="current-password" value={formData.password} onChange={(event) => setFormData({ ...formData, password: event.target.value })} required />
              </label>
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Connexion…' : 'Se connecter'}<span aria-hidden="true">→</span></button>
              <button className="auth-demo" type="button" disabled={loading} onClick={handleDemo}>Essayer la démo</button>
              <p className="auth-demo-note">Une entreprise fictive, prête en quelques secondes — sans compte, sans engagement.</p>
              <button className="auth-quiet-link" type="button" onClick={() => changeMode('forgot')}>Mot de passe oublié ?</button>
              <div className="auth-switch">Pas encore de compte ? <button type="button" onClick={() => changeMode('register')}>Créer un compte</button></div>
            </form>
          )}

          {mode === 'register' && (
            <form className="auth-form auth-form-register" onSubmit={handleRegister}>
              <div className="auth-heading">
                <span className="auth-kicker">Commencez simplement</span>
                <h2>Créer un compte</h2>
                <p>Quelques informations pour ouvrir votre espace Lite.</p>
              </div>
              <Messages error={error} success={success} />
              <div className="auth-fields-grid">
                <label>Nom d’utilisateur
                  <input autoComplete="username" value={registerData.username} onChange={(event) => setRegisterData({ ...registerData, username: event.target.value })} required />
                </label>
                <label>Email
                  <input type="email" autoComplete="email" value={registerData.email} onChange={(event) => setRegisterData({ ...registerData, email: event.target.value })} required />
                </label>
                <label>Nom
                  <input autoComplete="family-name" value={registerData.nom} onChange={(event) => setRegisterData({ ...registerData, nom: event.target.value })} />
                </label>
                <label>Prénom
                  <input autoComplete="given-name" value={registerData.prenom} onChange={(event) => setRegisterData({ ...registerData, prenom: event.target.value })} />
                </label>
                <label>Mot de passe
                  <input type="password" autoComplete="new-password" minLength={12} maxLength={72} value={registerData.password} onChange={(event) => setRegisterData({ ...registerData, password: event.target.value })} required />
                </label>
                <label>Confirmer le mot de passe
                  <input type="password" autoComplete="new-password" minLength={12} maxLength={72} value={registerData.confirmPassword} onChange={(event) => setRegisterData({ ...registerData, confirmPassword: event.target.value })} required />
                </label>
              </div>
              <div className="auth-company-label">Votre entreprise <span>Facultatif</span></div>
              <div className="auth-fields-grid auth-company-grid">
                <label>Nom de l’entreprise
                  <input autoComplete="organization" value={registerData.entrepriseNom} onChange={(event) => setRegisterData({ ...registerData, entrepriseNom: event.target.value })} />
                </label>
                <label>Téléphone
                  <input type="tel" autoComplete="tel" value={registerData.entrepriseTelephone} onChange={(event) => setRegisterData({ ...registerData, entrepriseTelephone: event.target.value })} />
                </label>
                <label>Taux de TVA
                  <select value={tauxTvaChoix} onChange={(event) => setTauxTvaChoix(event.target.value)}>
                    <option value="18">18 % — taux normal</option>
                    <option value="0">0 % — exonéré de TVA</option>
                    <option value="personnalise">Taux personnalisé…</option>
                  </select>
                </label>
                {tauxTvaChoix === 'personnalise' && (
                  <label>Taux personnalisé (%)
                    <input type="number" min="0" max="100" step="0.01" placeholder="Ex. : 7,5" value={tauxTvaPerso} onChange={(event) => setTauxTvaPerso(event.target.value)} required />
                  </label>
                )}
              </div>
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Création…' : 'Créer mon compte'}<span aria-hidden="true">→</span></button>
              <div className="auth-switch">Déjà inscrit ? <button type="button" onClick={() => changeMode('login')}>Retour à la connexion</button></div>
            </form>
          )}

          {mode === 'verify' && (
            <form className="auth-form" onSubmit={handleVerify}>
              <div className="auth-heading">
                <span className="auth-kicker">Dernière étape</span>
                <h2>Vérifiez votre e-mail</h2>
                <p>Un code à 6 chiffres a été envoyé à <strong>{verifyEmail}</strong>. Il est valable 15 minutes : votre essai gratuit de 30 jours démarrera une fois l’adresse vérifiée.</p>
              </div>
              <Messages error={error} success={success} />
              <label>Code de vérification
                <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={verifyCode} onChange={(event) => setVerifyCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required />
              </label>
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Vérification…' : 'Vérifier mon adresse'}<span aria-hidden="true">→</span></button>
              <button className="auth-quiet-link" type="button" disabled={resending || retryAfter > 0} onClick={handleResend}>
                {resending ? 'Envoi…' : retryAfter > 0 ? `Renvoyer le code (${retryAfter} s)` : 'Renvoyer le code'}
              </button>
              <button className="auth-quiet-link" type="button" onClick={() => setShowCorrection((value) => !value)}>
                {showCorrection ? 'Annuler la correction' : 'Corriger mon adresse e-mail'}
              </button>
              {showCorrection && (
                <label>Nouvelle adresse e-mail
                  <input type="email" autoComplete="email" value={nouvelEmail} onChange={(event) => setNouvelEmail(event.target.value)} placeholder="nouvelle-adresse@exemple.com" />
                </label>
              )}
              <div className="auth-switch">Adresse déjà vérifiée ? <button type="button" onClick={() => changeMode('login')}>Retour à la connexion</button></div>
            </form>
          )}

          {mode === 'forgot' && (
            <form className="auth-form" onSubmit={handleForgotPassword}>
              <div className="auth-heading">
                <span className="auth-kicker">On vous aide à revenir</span>
                <h2>Mot de passe oublié</h2>
                <p>Entrez votre adresse email pour réinitialiser votre mot de passe.</p>
              </div>
              <Messages error={error} success={success} />
              <label>Email
                <input type="email" autoComplete="email" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} required />
              </label>
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Envoi…' : 'Envoyer le lien'}<span aria-hidden="true">→</span></button>
              <button className="auth-quiet-link" type="button" onClick={() => changeMode('login')}>Retour à la connexion</button>
            </form>
          )}
          <div className="auth-guide-link">
            Besoin d’aide ? <Link href="/guide">Consulter le guide d’utilisation</Link> · <Link href="/guide#forfaits">Voir les forfaits</Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function Messages({ error, success }) {
  return (
    <>
      {error && <div className="auth-message auth-error" role="alert">{error}</div>}
      {success && <div className="auth-message auth-success" role="status">{success}</div>}
    </>
  );
}
