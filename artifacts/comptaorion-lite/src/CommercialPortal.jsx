import { useCallback, useEffect, useState } from 'react';
import './commercial-portal.css';

const TOKEN_KEY = 'commercialPortalToken';
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

function unwrap(value) {
  return value?.data?.data ?? value?.data ?? value;
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(number)} XOF` : '—';
}

function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
}

async function portalRequest(path, options = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const response = await fetch(`/api/commercial-portal${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  let result = {};
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const failure = new Error(result.message || result.error || 'Une erreur est survenue. Réessayez.');
    failure.status = response.status;
    throw failure;
  }
  return unwrap(result);
}

function PortalLoading() {
  return <div className="cp-loading" data-testid="commercial-state-loading" aria-label="Chargement"><i /><i /><i /><i /></div>;
}

function PortalError({ message, retry }) {
  return <section className="cp-state" role="alert" data-testid="commercial-state-error"><span className="cp-state-mark">!</span><h2>Impossible de charger votre espace</h2><p>{message}</p><button className="cp-button cp-button-primary" data-testid="commercial-button-retry" onClick={retry}>Réessayer</button></section>;
}

function PortalEmpty({ title, detail }) {
  return <div className="cp-empty" data-testid="commercial-state-empty"><span className="cp-empty-line" /><strong>{title}</strong><p>{detail}</p></div>;
}

export default function CommercialPortal() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [profile, setProfile] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [page, setPage] = useState('overview');
  const [reports, setReports] = useState(null);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [notice, setNotice] = useState('');

  const loadPortal = useCallback(async () => {
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    setLoading(true);
    setError('');
    try {
      const [me, data] = await Promise.all([
        portalRequest('/me'),
        portalRequest('/dashboard'),
      ]);
      setProfile(me);
      setDashboard(data);
      setToken(sessionStorage.getItem(TOKEN_KEY) || '');
    } catch (loadFailure) {
      setError(loadFailure.message || 'Chargement indisponible.');
      if (loadFailure.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken('');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) loadPortal();
  }, [token, loadPortal]);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await portalRequest(`/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setReports(result);
    } catch (loadFailure) {
      setError(loadFailure.message || 'Le rapport est momentanément indisponible.');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (token && page === 'reports') loadReports();
  }, [token, page, loadReports]);

  const login = async (event) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const result = await portalRequest('/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const authToken = result.token ?? result.data?.token;
      if (!result.success || !authToken) throw new Error(result.message || 'Identifiants incorrects ou session indisponible.');
      sessionStorage.setItem(TOKEN_KEY, authToken);
      setToken(authToken);
      setProfile(result.commercial ?? result.data?.commercial ?? null);
      setPassword('');
    } catch (loginFailure) {
      setLoginError(loginFailure.message || 'Connexion impossible. Vérifiez vos identifiants.');
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setProfile(null);
    setDashboard(null);
    setReports(null);
    setPage('overview');
    setNotice('Vous êtes déconnecté.');
  };

  const displayName = [profile?.prenom, profile?.nom].filter(Boolean).join(' ') || 'Espace commercial';
  const fullSales = dashboard?.ventes || [];
  const referralLink = dashboard?.lienParrainage
    ? new URL(dashboard.lienParrainage, window.location.origin).href
    : '';

  if (!token) return <main className="cp-auth-shell" data-testid="commercial-login">
    <section className="cp-auth-aside">
      <div className="cp-brand"><span className="cp-brand-mark">O</span><strong>ComptaOrion <em>Lite</em></strong></div>
      <div className="cp-auth-copy"><span className="cp-eyebrow">Espace commercial</span><h1>Votre activité.<br /><i>En clair.</i></h1><p>Retrouvez les entreprises que vous avez accompagnées, vos ventes et votre rapport de période dans un espace qui vous est réservé.</p></div>
      <div className="cp-auth-foot"><span className="cp-live-dot" /> Portail sécurisé · accès personnel</div>
    </section>
    <section className="cp-auth-main">
      <form className="cp-login-card" onSubmit={login} data-testid="form-commercial-login">
        <span className="cp-eyebrow">Bienvenue</span><h2>Connexion commerciale</h2><p>Utilisez les identifiants communiqués par votre administrateur.</p>
        {loginError && <div className="cp-form-error" role="alert" data-testid="commercial-login-error">{loginError}</div>}
        <label className="cp-field">Adresse e-mail<input data-testid="commercial-input-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@entreprise.com" /></label>
        <label className="cp-field">Mot de passe<input data-testid="commercial-input-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Votre mot de passe" /></label>
        <button className="cp-button cp-button-primary cp-login-submit" data-testid="commercial-button-login" disabled={loginBusy}>{loginBusy ? 'Connexion…' : 'Accéder à mon espace'}<span aria-hidden="true">→</span></button>
        <small className="cp-login-note">Votre session commerciale est indépendante de votre compte client ComptaOrion Lite.</small>
      </form>
    </section>
  </main>;

  const stats = dashboard?.stats || {};
  const reportStats = reports?.stats || {};
  const reportSales = reports?.ventes || [];
  const reportQuery = () => {
    const rows = reportSales;
    const csv = [
      ['Date', 'Client', 'Vente (XOF)', 'Commission (XOF)', 'État'],
      ...rows.map((row) => [row.dateVente || '', row.clientNom || '', row.montantVente ?? '', row.commission ?? '', row.statut || '']),
    ].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `rapport-commercial-${from}-${to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const copyReferral = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setNotice('Lien de parrainage copié.');
    } catch {
      setNotice('Copie indisponible sur cet appareil. Sélectionnez le lien pour le copier.');
    }
  };

  return <div className="cp-app" data-testid="commercial-dashboard">
    <aside className="cp-sidebar">
      <div className="cp-brand"><span className="cp-brand-mark">O</span><strong>ComptaOrion <em>Lite</em></strong></div>
      <span className="cp-nav-caption">Mon espace</span>
      <nav className="cp-nav" aria-label="Navigation commerciale">
        <button data-testid="commercial-nav-overview" aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}><span>▦</span>Vue d’ensemble</button>
        <button data-testid="commercial-nav-reports" aria-current={page === 'reports' ? 'page' : undefined} onClick={() => setPage('reports')}><span>▤</span>Rapports</button>
      </nav>
      <div className="cp-sidebar-bottom"><div className="cp-rep-profile"><span className="cp-avatar">{`${profile?.prenom?.[0] || ''}${profile?.nom?.[0] || ''}`.toUpperCase() || 'CO'}</span><div><strong data-testid="commercial-profile-name">{displayName}</strong><small>{profile?.region || 'Commercial'}</small></div></div><button className="cp-logout" data-testid="commercial-button-logout" onClick={logout}>Quitter mon espace <span aria-hidden="true">↗</span></button></div>
    </aside>
    <main className="cp-main">
      <header className="cp-topbar"><div className="cp-mobile-brand"><span className="cp-brand-mark">O</span><strong>ComptaOrion <em>Lite</em></strong></div><div className="cp-crumb">Espace commercial <span>/</span><strong>{page === 'reports' ? 'Rapports' : 'Vue d’ensemble'}</strong></div><div className="cp-top-profile"><span className="cp-live-dot" /> Portefeuille personnel</div></header>
      <div className="cp-content">
        {notice && <div className="cp-notice" role="status" data-testid="commercial-status-notice">{notice}<button aria-label="Fermer le message" onClick={() => setNotice('')}>×</button></div>}
        <header className="cp-page-head"><div><span className="cp-eyebrow">{page === 'reports' ? 'Votre activité · rapport' : 'Votre espace · ' + (profile?.region || 'Afrique francophone')}</span><h1>{page === 'reports' ? 'Le détail de vos résultats.' : `Bonjour ${profile?.prenom || ''}.`}</h1><p>{page === 'reports' ? 'Choisissez une période pour consulter et exporter vos ventes et commissions.' : 'Un aperçu net de vos recommandations, de vos ventes et de votre progression.'}</p></div>{page === 'reports' && <button className="cp-button cp-button-outline" data-testid="commercial-button-print" onClick={() => window.print()}>Imprimer le rapport</button>}</header>
        {loading ? <PortalLoading /> : error ? <PortalError message={error} retry={page === 'reports' ? loadReports : loadPortal} /> : page === 'overview' ? <>
          <section className="cp-metrics" aria-label="Indicateurs commerciaux">
            <Metric label="Clients apportés" value={stats.total_clients} detail={`${stats.clients_actifs ?? 0} comptes actifs`} accent="coral" testId="commercial-metric-clients" />
            <Metric label="Chiffre d’affaires généré" value={money(stats.ca_total)} detail={`${money(stats.ca_mois)} ce mois-ci`} accent="sand" testId="commercial-metric-revenue" />
            <Metric label="Commissions cumulées" value={money(stats.commissions_totales)} detail={`${money(stats.commissions_mois)} ce mois-ci`} accent="ink" testId="commercial-metric-commissions" />
            <Metric label="Taux de commission" value="10 %" detail="Fixe sur les ventes confirmées attribuées" accent="mint" testId="commercial-metric-rate" />
          </section>
           <section className="cp-referral"><div><span className="cp-eyebrow">Votre lien de parrainage</span><h2>Un lien simple à partager.</h2><p>Chaque inscription attribuée à ce lien rejoint votre portefeuille.</p></div><div className="cp-link-copy"><input aria-label="Lien de parrainage" data-testid="commercial-referral-link" readOnly value={referralLink || 'Lien non disponible'} onFocus={(event) => event.target.select()} /><button className="cp-button cp-button-primary" data-testid="commercial-button-copy-link" disabled={!referralLink} onClick={copyReferral}>Copier le lien</button></div></section>
          <div className="cp-overview-grid">
            <section className="cp-panel"><PanelHeader title="Mes derniers clients" detail="Entreprises associées à votre activité." /><PortalClientTable clients={(dashboard?.clients || []).slice(0, 5)} compact /></section>
            <section className="cp-panel cp-sales-panel"><PanelHeader title="Ventes récentes" detail="Ventes et commissions enregistrées." /><PortalSalesTable sales={fullSales.slice(0, 5)} compact /></section>
          </div>
           <div className="cp-commission-note"><span className="cp-note-mark">10%</span><p><strong>Un taux clair, sans surprise.</strong> Votre commission est fixée à 10 % des ventes confirmées attribuées à votre portefeuille.</p></div>
        </> : <>
          <section className="cp-report-controls" aria-label="Période du rapport">
            <label className="cp-field">Du<input type="date" data-testid="commercial-report-from" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="cp-field">Au<input type="date" data-testid="commercial-report-to" value={to} min={from} max={today()} onChange={(event) => setTo(event.target.value)} /></label>
            <button className="cp-button cp-button-outline" data-testid="commercial-button-refresh-report" onClick={loadReports}>Actualiser</button>
            <button className="cp-button cp-button-primary" data-testid="commercial-button-export-report" disabled={!reports} onClick={reportQuery}>Exporter CSV</button>
          </section>
          <div className="cp-report-period" data-testid="commercial-report-period">Période du {date(reports?.period?.from || from)} au {date(reports?.period?.to || to)}</div>
          <section className="cp-report-metrics">
            <Metric label="Clients apportés" value={reportStats.clients ?? '—'} detail="Sur la période sélectionnée" accent="coral" testId="commercial-report-clients" />
            <Metric label="Ventes enregistrées" value={reportStats.ventes ?? '—'} detail="Toutes les ventes attribuées" accent="sand" testId="commercial-report-sales" />
            <Metric label="Chiffre d’affaires" value={money(reportStats.ca)} detail="XOF · période sélectionnée" accent="ink" testId="commercial-report-revenue" />
             <Metric label="Commissions" value={money(reportStats.commissions)} detail="Ventes confirmées · taux fixe de 10 %" accent="mint" testId="commercial-report-commissions" />
          </section>
          <section className="cp-panel cp-report-table"><PanelHeader title="Ventes de la période" detail={`${reportSales.length} ligne${reportSales.length === 1 ? '' : 's'} dans ce rapport.`} />{reportSales.length ? <PortalSalesTable sales={reportSales} /> : <PortalEmpty title="Aucune vente sur cette période." detail="Essayez d’élargir les dates pour retrouver vos résultats." />}</section>
        </>}
      </div>
    </main>
    <nav className="cp-mobile-nav" aria-label="Navigation mobile"><button data-testid="commercial-mobile-nav-overview" aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}>Vue d’ensemble</button><button data-testid="commercial-mobile-nav-reports" aria-current={page === 'reports' ? 'page' : undefined} onClick={() => setPage('reports')}>Rapports</button><button data-testid="commercial-mobile-logout" onClick={logout}>Déconnexion</button></nav>
  </div>;
}

function Metric({ label, value, detail, accent, testId }) {
  return <article className={`cp-metric cp-metric-${accent}`} data-testid={testId}><span>{label}</span><strong>{value === undefined || value === null ? '—' : value}</strong><small>{detail}</small></article>;
}

function PanelHeader({ title, detail }) {
  return <div className="cp-panel-head"><div><h2>{title}</h2><p>{detail}</p></div></div>;
}

function PortalClientTable({ clients, compact = false }) {
  if (!clients.length) return <PortalEmpty title="Pas encore de client apporté." detail="Vos nouvelles entreprises apparaîtront ici après leur inscription." />;
  return <div className="cp-table-wrap"><table className="cp-table" data-testid="commercial-table-clients"><thead><tr><th>Entreprise</th><th>Inscription</th>{!compact && <th>Origine</th>}<th>État</th></tr></thead><tbody>{clients.map((client) => <tr key={client.id} data-testid={`commercial-row-client-${client.id}`}><td><strong>{client.entrepriseNom || 'Entreprise sans nom'}</strong></td><td>{date(client.dateInscription)}</td>{!compact && <td>{client.source || '—'}</td>}<td><span className={`cp-status cp-status-${String(client.statut || '').toLowerCase().replaceAll(' ', '-')}`}>{client.statut || 'Non renseigné'}</span></td></tr>)}</tbody></table></div>;
}

function PortalSalesTable({ sales, compact = false }) {
  if (!sales.length) return <PortalEmpty title="Aucune vente enregistrée." detail="Vos ventes apparaîtront ici dès leur attribution." />;
  return <div className="cp-table-wrap"><table className="cp-table" data-testid="commercial-table-sales"><thead><tr><th>Client</th><th>Montant</th>{!compact && <th>Commission</th>}<th>Date</th>{!compact && <th>État</th>}</tr></thead><tbody>{sales.map((sale) => <tr key={sale.id} data-testid={`commercial-row-sale-${sale.id}`}><td><strong>{sale.clientNom || 'Entreprise sans nom'}</strong></td><td className="cp-amount">{money(sale.montantVente)}</td>{!compact && <td className="cp-amount">{money(sale.commission)}</td>}<td>{date(sale.dateVente)}</td>{!compact && <td><span className="cp-status">{sale.statut || 'Non renseigné'}</span></td>}</tr>)}</tbody></table></div>;
}
