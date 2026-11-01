import { useCallback, useEffect, useMemo, useState } from 'react';
import api from './api.js';
import './commercial-space.css';

const NAV = [
  { id: 'overview', label: 'Vue d’ensemble', icon: '▦' },
  { id: 'clients', label: 'Clients', icon: '◎' },
  { id: 'plans', label: 'Forfaits', icon: '▤' },
  { id: 'subscriptions', label: 'Abonnements', icon: '↻' },
  { id: 'sales', label: 'Ventes', icon: '↗' },
  { id: 'reps', label: 'Commerciaux', icon: '◌' },
];

const blankData = {
  dashboard: null, clients: [], plans: [], subscriptions: [], sales: [], reps: [], readiness: null,
};

function unwrap(value) {
  return value?.data?.data ?? value?.data ?? value;
}

function asList(value) {
  const result = unwrap(value);
  return Array.isArray(result) ? result : [];
}

function getErrorMessage(error) {
  return error?.data?.message || error?.data?.error || error?.message || 'Une erreur est survenue. Réessayez.';
}

function formatMoney(value, currency = 'XOF') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(amount) + ` ${currency || 'XOF'}`;
  } catch {
    return `${Math.round(amount).toLocaleString('fr-FR')} ${currency || 'XOF'}`;
  }
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function statusLabel(value) {
  const labels = {
    actif: 'Actif', active: 'Actif', trial: 'Essai', suspendu: 'Suspendu', inactif: 'Inactif',
    expire: 'Expiré', expiré: 'Expiré', annule: 'Annulé', annulé: 'Annulé',
    confirmée: 'Confirmée', confirmee: 'Confirmée', en_attente: 'En attente', pending: 'En attente',
  };
  return labels[String(value || '').toLowerCase()] || value || 'Non renseigné';
}

function StatusBadge({ value, testId }) {
  const normalized = String(value || '').toLowerCase().replaceAll(' ', '_');
  return <span className={`cs-badge cs-badge-${normalized}`} data-testid={testId || 'status-record'}>{statusLabel(value)}</span>;
}

function EmptyState({ title, detail }) {
  return <div className="cs-empty" data-testid="state-empty"><span className="cs-empty-mark" aria-hidden="true">—</span><strong>{title}</strong><p>{detail}</p></div>;
}

function LoadingState() {
  return <div className="cs-loading" aria-label="Chargement des données" data-testid="state-loading"><span className="cs-skeleton" /><span className="cs-skeleton" /><span className="cs-skeleton" /></div>;
}

function ErrorState({ message, retry }) {
  return <div className="cs-error" role="alert" data-testid="state-error"><span className="cs-empty-mark cs-error-mark" aria-hidden="true">!</span><strong>Chargement impossible</strong><p>{message}</p><button className="cs-button cs-button-outline" data-testid="button-retry" onClick={retry}>Réessayer</button></div>;
}

function Modal({ title, description, children, onClose, testId }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="cs-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cs-modal" role="dialog" aria-modal="true" aria-labelledby="cs-modal-title" data-testid={testId || 'dialog-edit'}>
      <header className="cs-modal-head"><div><h2 id="cs-modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="cs-close" type="button" aria-label="Fermer" data-testid="button-close-dialog" onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>;
}

async function patchSaasAdmin(path, body) {
  const response = await fetch(`/api/saas-admin/${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + localStorage.getItem('token'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let result = {};
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const error = new Error(result.message || result.error || 'La modification a échoué.');
    error.status = response.status;
    error.data = result;
    throw error;
  }
  return result;
}

export default function CommercialSpace({ onBack = () => {} }) {
  const [page, setPage] = useState('overview');
  const [data, setData] = useState(blankData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [clientToEdit, setClientToEdit] = useState(null);
  const [planToEdit, setPlanToEdit] = useState(null);
  const [createPlanOpen, setCreatePlanOpen] = useState(false);
  const [proposalsBusy, setProposalsBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [dashboard, clients, plans, subscriptions, sales, reps, readiness] = await Promise.all([
        api.get('/saas-admin/dashboard'),
        api.get('/saas-admin/clients'),
        api.get('/saas-admin/plans'),
        api.get('/saas-admin/abonnements'),
        api.get('/saas-admin/ventes'),
        api.get('/saas-admin/commerciaux'),
        api.get('/saas-admin/payment-readiness'),
      ]);
      setData({
        dashboard: unwrap(dashboard),
        clients: asList(clients),
        plans: asList(plans),
        subscriptions: asList(subscriptions),
        sales: asList(sales),
        reps: asList(reps),
        readiness: unwrap(readiness),
      });
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigate = (id) => { setPage(id); setSearch(''); };
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('fr');
    const match = (...parts) => !query || parts.filter(Boolean).join(' ').toLocaleLowerCase('fr').includes(query);
    if (page === 'clients') return data.clients.filter((row) => match(row.entrepriseNom, row.email, row.telephone, row.pays, row.statut, row.commercial));
    if (page === 'plans') return data.plans.filter((row) => match(row.nom, row.descriptionFeatures, row.periode));
    if (page === 'subscriptions') return data.subscriptions.filter((row) => match(row.entreprise, row.plan, row.statut));
    if (page === 'sales') return data.sales.filter((row) => match(row.client, row.commercial, row.source, row.statut));
    if (page === 'reps') return data.reps.filter((row) => match(row.prenom, row.nom, row.email, row.region));
    return [];
  }, [data, page, search]);

  const performMutation = async (operation, successMessage) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      setToast({ type: 'success', message: successMessage });
      return true;
    } catch (error) {
      setToast({ type: 'error', message: getErrorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createProposals = async () => {
    setProposalsBusy(true);
    try {
      const response = unwrap(await api.post('/saas-admin/plans/proposals', {}));
      await refresh();
      setToast({ type: 'success', message: `${Number(response?.created || 0)} brouillon(s) préparé(s). Aucun forfait n’a été activé.` });
    } catch (error) {
      setToast({ type: 'error', message: getErrorMessage(error) });
    } finally {
      setProposalsBusy(false);
    }
  };

  const saveClient = async (client, changes) => {
    const success = await performMutation(() => patchSaasAdmin(`clients/${client.id}`, changes), 'Les informations du client ont été mises à jour.');
    if (success) setClientToEdit(null);
  };

  const savePlan = async (plan, changes) => {
    const success = await performMutation(() => patchSaasAdmin(`plans/${plan.id}`, changes), 'Le forfait a été mis à jour.');
    if (success) setPlanToEdit(null);
  };

  const createPlan = async (body) => {
    const success = await performMutation(() => api.post('/saas-admin/plans', body), 'Le brouillon de forfait a été créé.');
    if (success) setCreatePlanOpen(false);
  };

  const heading = {
    overview: ['Pilotage plateforme', 'Votre activité, en un regard.', 'Le poste de contrôle privé de ComptaOrion Lite. Suivez les comptes, les forfaits et les revenus sans perdre le fil.'],
    clients: ['Portefeuille', 'Clients SaaS', 'Suivez l’état des comptes, les coordonnées et les dernières informations de chaque entreprise.'],
    plans: ['Offre commerciale', 'Forfaits', 'Préparez et ajustez vos forfaits. Les brouillons restent inactifs tant qu’ils ne sont pas validés.'],
    subscriptions: ['Revenus récurrents', 'Abonnements', 'Consultez les engagements, échéances et montants mensuels actuellement enregistrés.'],
    sales: ['Activité commerciale', 'Ventes', 'Suivez les ventes SaaS, leurs commissions, leur source et leur état de confirmation.'],
    reps: ['Équipe terrain', 'Commerciaux', 'Gardez une vue claire sur les régions, objectifs et taux de commission.'],
  }[page];

  const actionForPage = page === 'plans'
    ? <div className="cs-head-actions"><button className="cs-button cs-button-outline" data-testid="button-create-proposals" disabled={proposalsBusy || busy} onClick={createProposals}>{proposalsBusy ? 'Préparation…' : 'Préparer les 3 brouillons'}</button><button className="cs-button cs-button-primary" data-testid="button-new-plan" onClick={() => setCreatePlanOpen(true)}>+ Nouveau brouillon</button></div>
    : null;

  return <div className="commercial" data-testid="commercial-space">
    <div className="cs-frame">
      <aside className="cs-sidebar">
        <div className="cs-brand"><span className="cs-brand-mark">O</span><div><strong>ComptaOrion <span style={{ color: 'var(--cs-coral)' }}>Lite</span></strong><small>Administration plateforme</small></div></div>
        <p className="cs-nav-label">Espace propriétaire</p>
        <nav className="cs-nav" aria-label="Navigation commerciale">
          {NAV.map((item) => <button key={item.id} type="button" aria-current={page === item.id ? 'page' : undefined} data-testid={`nav-${item.id}`} onClick={() => navigate(item.id)}><span className="cs-nav-icon" aria-hidden="true">{item.icon}</span>{item.label}</button>)}
        </nav>
        <div className="cs-side-bottom"><button className="cs-back" type="button" data-testid="button-back-lite" onClick={onBack}><span aria-hidden="true">←</span> Retour à ComptaOrion Lite</button><div className="cs-owner"><span className="cs-owner-mark">CO</span><span>Contrôle plateforme</span></div></div>
      </aside>
      <main className="cs-main">
        <header className="cs-topbar">
          <span className="cs-mobile-brand"><span className="cs-brand-mark" style={{ width: 27, height: 27, borderRadius: 8, fontSize: 13 }}>O</span>ComptaOrion <b>Lite</b></span>
          <span className="cs-breadcrumb">Espace propriétaire <span aria-hidden="true">/</span> <strong>{NAV.find((item) => item.id === page)?.label}</strong></span>
          <span className="cs-top-right"><i className="cs-live-dot" /> Données de la plateforme</span>
        </header>
        <div className="cs-content">
          <header className="cs-page-head">
            <div><span className="cs-kicker">{heading[0]}</span><h1 data-testid="text-page-title">{heading[1]}</h1><p>{heading[2]}</p></div>
            {actionForPage}
          </header>

          {loading ? <LoadingState /> : loadError ? <ErrorState message={loadError} retry={refresh} /> : <>
            {page === 'overview' && <Overview data={data} onNavigate={navigate} />}
            {page !== 'overview' && <section aria-label={`Liste ${heading[1]}`}>
              <div className="cs-toolbar">
                <label className="cs-search"><span aria-hidden="true">⌕</span><input data-testid={`input-search-${page}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Rechercher ${heading[1].toLocaleLowerCase('fr')}…`} aria-label={`Rechercher dans ${heading[1].toLocaleLowerCase('fr')}`} /></label>
                <span className="cs-inline-empty" data-testid={`text-count-${page}`}>{filtered.length} résultat{filtered.length > 1 ? 's' : ''}</span>
              </div>
              {filtered.length === 0 ? <EmptyState title={search ? 'Aucun résultat trouvé.' : emptyTitle(page)} detail={search ? 'Essayez un autre terme de recherche.' : emptyDetail(page)} /> :
                <section className="cs-panel"><TableForPage page={page} rows={filtered} onEditClient={setClientToEdit} onEditPlan={setPlanToEdit} /></section>}
              {page === 'plans' && <p className="cs-inline-note" style={{ marginTop: 12 }}>Les nouveaux forfaits et les trois propositions sont enregistrés comme brouillons inactifs. Aucun paiement ni accès payant n’est activé ici.</p>}
            </section>}
          </>}
        </div>
      </main>
    </div>
    <nav className="cs-mobile-nav" aria-label="Navigation commerciale mobile">
      {NAV.map((item) => <button key={item.id} type="button" aria-current={page === item.id ? 'page' : undefined} data-testid={`mobile-nav-${item.id}`} onClick={() => navigate(item.id)}><i aria-hidden="true">{item.icon}</i><span>{item.label}</span></button>)}
    </nav>
    {clientToEdit && <ClientEditor client={clientToEdit} busy={busy} onClose={() => setClientToEdit(null)} onSave={(changes) => saveClient(clientToEdit, changes)} />}
    {planToEdit && <PlanEditor plan={planToEdit} busy={busy} onClose={() => setPlanToEdit(null)} onSave={(changes) => savePlan(planToEdit, changes)} />}
    {createPlanOpen && <PlanEditor busy={busy} create onClose={() => setCreatePlanOpen(false)} onSave={createPlan} />}
    {toast && <div className={`cs-toast ${toast.type === 'error' ? 'cs-toast-error' : ''}`} role={toast.type === 'error' ? 'alert' : 'status'} data-testid="status-toast">{toast.message}</div>}
  </div>;
}

function emptyTitle(page) {
  return { clients: 'Aucun client enregistré.', plans: 'Aucun forfait trouvé.', subscriptions: 'Aucun abonnement enregistré.', sales: 'Aucune vente enregistrée.', reps: 'Aucun commercial enregistré.' }[page] || 'Aucune donnée à afficher.';
}
function emptyDetail(page) {
  return {
    clients: 'Les clients SaaS apparaîtront ici dès leur première inscription.',
    plans: 'Vous pouvez préparer les brouillons proposés ou créer un brouillon personnalisé.',
    subscriptions: 'Les abonnements apparaîtront ici lorsque des engagements seront enregistrés.',
    sales: 'Les ventes confirmées et en attente apparaîtront ici.',
    reps: 'Les membres de l’équipe commerciale apparaîtront ici lorsqu’ils seront ajoutés.',
  }[page] || 'Les données disponibles apparaîtront ici.';
}

function Overview({ data, onNavigate }) {
  const stats = data.dashboard?.stats || {};
  const recent = Array.isArray(data.dashboard?.recentClients) ? data.dashboard.recentClients : [];
  const readiness = data.readiness || {};
  const blocked = readiness.status === 'blocked' || readiness.configured === false;
  return <>
    <section className="cs-stats" aria-label="Indicateurs plateforme">
      <Stat label="Clients enregistrés" value={stats.total} detail={`${stats.actifs ?? 0} actifs · ${stats.essais ?? 0} en essai`} tone="warm" testId="metric-total-clients" />
      <Stat label="Abonnements actifs" value={stats.abonnements_actifs} detail={`${stats.suspendus ?? 0} comptes suspendus`} tone="mint" testId="metric-active-subscriptions" />
      <Stat label="Revenu mensuel" value={formatMoney(stats.revenu_mensuel, 'XOF')} detail="Montant mensuel actif" tone="ink" testId="metric-monthly-revenue" />
      <Stat label="Ventes confirmées" value={formatMoney(stats.ventes, 'XOF')} detail={`${formatMoney(stats.commissions, 'XOF')} de commissions`} tone="sand" testId="metric-sales" />
    </section>
    <div className="cs-dashboard-grid">
      <section className="cs-panel">
        <div className="cs-panel-head"><div><h2>Derniers comptes inscrits</h2><p>Les entreprises les plus récemment ajoutées à la plateforme.</p></div><button className="cs-button cs-button-quiet cs-button-small" data-testid="button-view-clients" onClick={() => onNavigate('clients')}>Tous les clients <span aria-hidden="true">→</span></button></div>
        {recent.length === 0 ? <EmptyState title="Aucune inscription récente." detail="Les nouvelles entreprises seront visibles ici." /> :
          <div className="cs-table-wrap"><table className="cs-table" data-testid="table-recent-clients"><thead><tr><th>Entreprise</th><th>Inscription</th><th>Source</th><th>État</th></tr></thead><tbody>
            {recent.map((client) => <tr key={client.id} data-testid={`row-recent-client-${client.id}`}><td><strong>{client.entrepriseNom || 'Entreprise sans nom'}</strong><small>{client.email || 'Adresse non renseignée'}</small></td><td>{formatDate(client.dateInscription)}</td><td>{client.source || '—'}</td><td><StatusBadge value={client.statut} testId={`status-recent-client-${client.id}`} /></td></tr>)}
          </tbody></table></div>}
      </section>
      <section className={`cs-ready ${blocked ? 'is-blocked' : ''}`} data-testid="card-payment-readiness">
        <div className="cs-ready-top"><span className="cs-ready-symbol" aria-hidden="true">{blocked ? '!' : 'W'}</span><div><small>Préparation des paiements</small><strong>Passerelle {readiness.provider || 'Whop'}</strong></div></div>
        <div className="cs-ready-status" data-testid="status-payment-readiness">{blocked ? 'Configuration bloquée' : 'Entreprise détectée'}</div>
        <p data-testid="text-payment-readiness-message">{readiness.message || 'La disponibilité des paiements n’a pas pu être confirmée.'}</p>
        <div className="cs-ready-foot"><span>Devise de référence</span><strong>{readiness.currency || 'XOF'}</strong></div>
      </section>
    </div>
    <section className="cs-notice cs-subsection" data-testid="notice-payment-safety"><strong>Paiements sécurisés.</strong> Un compte client ne peut pas être activé manuellement depuis ce poste. Aucun bouton de paiement ou de checkout n’est disponible dans cet espace.</section>
  </>;
}

function Stat({ label, value, detail, tone, testId }) {
  const displayValue = value === undefined || value === null ? '—' : value;
  return <article className={`cs-stat cs-stat-${tone}`} data-testid={testId}><span>{label}</span><strong>{displayValue}</strong><small>{detail}</small></article>;
}

function TableForPage({ page, rows, onEditClient, onEditPlan }) {
  if (page === 'clients') return <div className="cs-table-wrap"><table className="cs-table" data-testid="table-clients"><thead><tr><th>Entreprise</th><th>Contact</th><th>État</th><th>Inscription</th><th>Responsable</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-testid={`row-client-${row.id}`}><td><strong>{row.entrepriseNom || 'Entreprise sans nom'}</strong><small>{row.pays || 'Pays non renseigné'} · {row.source || 'Source inconnue'}</small></td><td><strong>{row.email || '—'}</strong><small>{row.telephone || 'Téléphone non renseigné'}</small></td><td><StatusBadge value={row.statut} testId={`status-client-${row.id}`} /></td><td>{formatDate(row.dateInscription)}<small>Dernière connexion : {formatDate(row.dateDerniereConnexion)}</small></td><td>{row.commercial || '—'}</td><td><button className="cs-button cs-button-outline cs-button-small" data-testid={`button-edit-client-${row.id}`} onClick={() => onEditClient(row)}>Gérer</button></td></tr>)}</tbody></table></div>;
  if (page === 'plans') return <div className="cs-table-wrap"><table className="cs-table" data-testid="table-plans"><thead><tr><th>Forfait</th><th>Tarif</th><th>Utilisateurs</th><th>Période</th><th>État</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-testid={`row-plan-${row.id}`}><td><strong>{row.nom}</strong><small>{row.descriptionFeatures || 'Aucune description de fonctionnalités.'}</small></td><td className="cs-number">{formatMoney(row.prix, row.devise || 'XOF')}</td><td>{row.limiteUtilisateurs ?? '—'}</td><td>{row.periode || '—'}</td><td><StatusBadge value={row.actif ? 'actif' : 'inactif'} testId={`status-plan-${row.id}`} /></td><td><button className="cs-button cs-button-outline cs-button-small" data-testid={`button-edit-plan-${row.id}`} onClick={() => onEditPlan(row)}>Modifier</button></td></tr>)}</tbody></table></div>;
  if (page === 'subscriptions') return <div className="cs-table-wrap"><table className="cs-table" data-testid="table-subscriptions"><thead><tr><th>Entreprise</th><th>Forfait</th><th>Montant mensuel</th><th>Période</th><th>État</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-testid={`row-subscription-${row.id}`}><td><strong>{row.entreprise || 'Entreprise sans nom'}</strong><small>Compte #{row.entrepriseId ?? '—'}</small></td><td>{row.plan || '—'}</td><td className="cs-number">{formatMoney(row.montantMensuel, row.devise || 'XOF')}</td><td>{formatDate(row.dateDebut)}<small>Échéance : {formatDate(row.dateExpiration)}</small></td><td><StatusBadge value={row.statut} testId={`status-subscription-${row.id}`} /></td></tr>)}</tbody></table></div>;
  if (page === 'sales') return <div className="cs-table-wrap"><table className="cs-table" data-testid="table-sales"><thead><tr><th>Client</th><th>Commercial</th><th>Montant</th><th>Commission</th><th>Date</th><th>Source / état</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-testid={`row-sale-${row.id}`}><td><strong>{row.client || 'Entreprise sans nom'}</strong></td><td>{row.commercial || 'Vente en ligne'}</td><td className="cs-number">{formatMoney(row.montantVente)}</td><td>{formatMoney(row.commission)}</td><td>{formatDate(row.dateVente)}</td><td>{row.source || '—'}<small><StatusBadge value={row.statut} testId={`status-sale-${row.id}`} /></small></td></tr>)}</tbody></table></div>;
  return <div className="cs-table-wrap"><table className="cs-table" data-testid="table-reps"><thead><tr><th>Commercial</th><th>Coordonnées</th><th>Région</th><th>Commission</th><th>Objectif mensuel</th><th>État</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-testid={`row-rep-${row.id}`}><td><strong>{[row.prenom, row.nom].filter(Boolean).join(' ') || 'Sans nom'}</strong><small>Depuis le {formatDate(row.createdAt)}</small></td><td>{row.email || '—'}<small>{row.telephone || 'Téléphone non renseigné'}</small></td><td>{row.region || '—'}</td><td>{row.commission ?? '—'}{row.commission !== undefined && row.commission !== null ? '%' : ''}</td><td className="cs-number">{formatMoney(row.objectifMensuel)}</td><td><StatusBadge value={row.actif ? 'actif' : 'inactif'} testId={`status-rep-${row.id}`} /></td></tr>)}</tbody></table></div>;
}

function ClientEditor({ client, busy, onClose, onSave }) {
  const [notes, setNotes] = useState(client.notes || '');
  const safeStatuses = ['trial', 'suspendu', 'inactif'];
  const [status, setStatus] = useState(safeStatuses.includes(client.statut) ? client.statut : '__unchanged');
  const submit = (event) => {
    event.preventDefault();
    onSave({ ...(status === '__unchanged' ? {} : { statut: status }), notes });
  };
  return <Modal title="Gérer ce client" description={client.entrepriseNom || client.email || `Compte #${client.id}`} onClose={onClose} testId="dialog-client-editor">
    <form className="cs-form" onSubmit={submit}>
      <label className="cs-field">État du compte<select data-testid="select-client-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="__unchanged">Conserver l’état actuel — {statusLabel(client.statut)}</option><option value="trial">Essai</option><option value="suspendu">Suspendu</option><option value="inactif">Inactif</option></select></label>
      <label className="cs-field">Note interne<textarea data-testid="input-client-notes" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ajouter un contexte utile pour le suivi…" /></label>
      <p className="cs-inline-note">L’activation payante n’est pas modifiable ici. Elle dépend d’un paiement vérifié.</p>
      <div className="cs-form-actions"><button type="button" className="cs-button cs-button-outline" data-testid="button-cancel-client" onClick={onClose}>Annuler</button><button className="cs-button cs-button-primary" data-testid="button-save-client" disabled={busy}>Enregistrer</button></div>
    </form>
  </Modal>;
}

function PlanEditor({ plan, busy, create = false, onClose, onSave }) {
  const [form, setForm] = useState({
    nom: plan?.nom || '',
    prix: plan?.prix ?? '',
    limiteUtilisateurs: plan?.limiteUtilisateurs ?? 1,
    periode: plan?.periode || 'mensuel',
    descriptionFeatures: plan?.descriptionFeatures || '',
  });
  const change = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event) => {
    event.preventDefault();
    const body = {
      nom: form.nom.trim(),
      prix: Number(form.prix),
      limiteUtilisateurs: Number(form.limiteUtilisateurs),
      periode: form.periode,
      descriptionFeatures: form.descriptionFeatures,
    };
    onSave(body);
  };
  return <Modal title={create ? 'Nouveau brouillon de forfait' : 'Modifier le forfait'} description={create ? 'Ce forfait sera créé inactif et ne sera pas proposé au paiement.' : `Édition de ${plan?.nom || 'ce forfait'} · l’état actif reste inchangé.`} onClose={onClose} testId={create ? 'dialog-create-plan' : 'dialog-edit-plan'}>
    <form className="cs-form" onSubmit={submit}>
      <label className="cs-field">Nom du forfait<input data-testid="input-plan-name" required maxLength={255} value={form.nom} onChange={change('nom')} /></label>
      <div className="cs-form-grid">
        <label className="cs-field">Prix mensuel (XOF)<input data-testid="input-plan-price" type="number" min="0" step="1" required value={form.prix} onChange={change('prix')} /></label>
        <label className="cs-field">Nombre d’utilisateurs<input data-testid="input-plan-users" type="number" min="1" max="10000" step="1" required value={form.limiteUtilisateurs} onChange={change('limiteUtilisateurs')} /></label>
      </div>
      <label className="cs-field">Période<select data-testid="select-plan-period" value={form.periode} onChange={change('periode')}><option value="mensuel">Mensuelle</option><option value="annuel">Annuelle</option></select></label>
      <label className="cs-field">Fonctionnalités<textarea data-testid="input-plan-description" maxLength={2000} value={form.descriptionFeatures} onChange={change('descriptionFeatures')} placeholder="Décrivez les fonctionnalités incluses…" /></label>
      <p className="cs-inline-note">{create ? 'Les champs facultatifs laissés vides sont enregistrés comme texte vide.' : 'Les valeurs sont préremplies. La description laissée vide sera enregistrée comme texte vide; les autres champs conservent leur valeur.'}</p>
      <div className="cs-form-actions"><button type="button" className="cs-button cs-button-outline" data-testid="button-cancel-plan" onClick={onClose}>Annuler</button><button className="cs-button cs-button-primary" data-testid="button-save-plan" disabled={busy}>{create ? 'Créer le brouillon' : 'Enregistrer les changements'}</button></div>
    </form>
  </Modal>;
}
