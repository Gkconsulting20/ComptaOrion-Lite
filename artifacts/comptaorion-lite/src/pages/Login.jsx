import { useState } from 'react';
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
};

export function Login({ onLoginSuccess }) {
  const [mode, setMode] = useState('login');
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [registerData, setRegisterData] = useState(initialRegister);
  const [resetEmail, setResetEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

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
      setError(requestError.message || 'Erreur de connexion');
    } finally {
      setLoading(false);
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
    if (registerData.password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/register', registerData);
      setSuccess('Compte créé avec succès ! Vous pouvez maintenant vous connecter.');
      setMode('login');
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
                  <input type="password" autoComplete="new-password" value={registerData.password} onChange={(event) => setRegisterData({ ...registerData, password: event.target.value })} required />
                </label>
                <label>Confirmer le mot de passe
                  <input type="password" autoComplete="new-password" value={registerData.confirmPassword} onChange={(event) => setRegisterData({ ...registerData, confirmPassword: event.target.value })} required />
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
              </div>
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Création…' : 'Créer mon compte'}<span aria-hidden="true">→</span></button>
              <div className="auth-switch">Déjà inscrit ? <button type="button" onClick={() => changeMode('login')}>Retour à la connexion</button></div>
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
