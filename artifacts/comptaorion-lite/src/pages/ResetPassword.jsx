import { useState } from 'react';
import { Link } from 'wouter';
import api from '../api.js';

// Réinitialisation du mot de passe par lien (28 nov. 2026) : le lien
// envoyé par e-mail (mot de passe oublié) aboutit ici avec ?token=…
// Le jeton est valable 1 heure. Le mot de passe doit contenir au moins
// 12 caractères (même règle que l'inscription).
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(token ? '' : 'Lien de réinitialisation invalide ou expiré.');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReset = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (newPassword.length < 12) {
      setError('Le mot de passe doit contenir au moins 12 caractères.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth-security/reset-password', { token, newPassword });
      setSuccess('Mot de passe réinitialisé. Vous pouvez maintenant vous connecter.');
    } catch (requestError) {
      setError(requestError.message || 'Réinitialisation impossible.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-content">
          <form className="auth-form" onSubmit={handleReset}>
            <div className="auth-heading">
              <span className="auth-kicker">ComptaOrion Lite</span>
              <h2>Réinitialiser le mot de passe</h2>
              <p>Choisissez un nouveau mot de passe pour votre compte.</p>
            </div>
            {error && <div className="auth-message auth-error" role="alert">{error}</div>}
            {success && <div className="auth-message auth-success" role="status">{success}</div>}
            <label>Nouveau mot de passe
              <input type="password" autoComplete="new-password" minLength={12} maxLength={72} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
            </label>
            <label>Confirmer le mot de passe
              <input type="password" autoComplete="new-password" minLength={12} maxLength={72} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
            </label>
            <button className="auth-submit" type="submit" disabled={loading || !token}>{loading ? 'Réinitialisation…' : 'Réinitialiser mon mot de passe'}<span aria-hidden="true">→</span></button>
            <div className="auth-switch"><Link href="/">Retour à la connexion</Link></div>
          </form>
        </div>
      </section>
    </main>
  );
}
