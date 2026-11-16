import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';
import { parseCsvDocument, suggestCsvMapping, validateMappedRows } from './csvHelper.js';
import './bank-reconciliation.css';

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const monthStart = () => `${today().slice(0, 8)}01`;
const responseData = (response) => response?.data?.data ?? response?.data ?? [];
const amountValue = (value, currency, language) =>
  `${Math.round(Number(value) || 0).toLocaleString(language === 'fr' ? 'fr-FR' : 'en-GB')} ${currency || 'FCFA'}`;
const dateLabel = (value, language) => {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10)
    : date.toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const errorMessage = (error, fallback) => error?.message || fallback;
const statusLabel = (status, t) => {
  const value = String(status || '').toLowerCase();
  if (['valide', 'validee', 'validated', 'validé', 'validée'].includes(value)) return t('Validé', 'Validated');
  if (['en_cours', 'draft', 'brouillon'].includes(value)) return t('En revue', 'In review');
  return status || t('À vérifier', 'To review');
};

function Skeleton() {
  return <div className="br-skeleton" aria-label="Chargement"><i /><i /><i /><i /></div>;
}

function EmptyHistory({ t }) {
  return <div className="br-history-empty"><strong>{t('Aucun rapprochement pour le moment.', 'No reconciliations yet.')}</strong><br />
    {t('Importez un relevé pour commencer une revue ligne par ligne.', 'Import a statement to begin a line-by-line review.')}</div>;
}

export default function BankReconciliationPage({ t = (fr) => fr, settings = {}, onChanged }) {
  const language = settings.language || 'fr';
  const currency = settings.currency || 'FCFA';
  const [accounts, setAccounts] = useState([]);
  const [history, setHistory] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [accountsError, setAccountsError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [accountId, setAccountId] = useState('');
  const [dateStart, setDateStart] = useState(monthStart);
  const [dateEnd, setDateEnd] = useState(today);
  const [closingBalance, setClosingBalance] = useState('');
  const [notes, setNotes] = useState('');
  const [csvDoc, setCsvDoc] = useState(null);
  const [csvMapping, setCsvMapping] = useState({ date: '', description: '', amount: '', debit: '', credit: '', reference: '' });
  const [fileLabel, setFileLabel] = useState('');
  const [csvIssues, setCsvIssues] = useState([]);
  const [statementLines, setStatementLines] = useState([]);
  const [previewData, setPreviewData] = useState(null);
  const [selectedTransactions, setSelectedTransactions] = useState({});
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeTab, setActiveTab] = useState('new');
  const [detail, setDetail] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountForm, setAccountForm] = useState({ nomCompte: '', banque: '', numeroCompte: '' });

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError('');
    try {
      const result = await api.get('/comptes-bancaires-lite');
      const list = responseData(result);
      setAccounts(Array.isArray(list) ? list : []);
      setAccountId((current) => current || String((Array.isArray(list) ? list.find((item) => item.actif) : null)?.id || ''));
    } catch (error) {
      setAccountsError(errorMessage(error, t('Les comptes bancaires ne sont pas disponibles.', 'Bank accounts could not be loaded.')));
    } finally { setAccountsLoading(false); }
  }, [t]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await api.get('/bank-reconciliations');
      const list = responseData(result);
      setHistory(Array.isArray(list) ? list : []);
    } catch (error) {
      setHistoryError(errorMessage(error, t('L’historique ne peut pas être chargé.', 'History could not be loaded.')));
    } finally { setHistoryLoading(false); }
  }, [t]);

  useEffect(() => { loadAccounts(); loadHistory(); }, [loadAccounts, loadHistory]);
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  const activeAccounts = useMemo(() => accounts.filter((account) => account.actif), [accounts]);
  const mappingResult = useMemo(() => csvDoc ? validateMappedRows(csvDoc, csvMapping) : { lines: [], issues: [] }, [csvDoc, csvMapping]);
  const matchedCount = Object.values(selectedTransactions).filter(Boolean).length;
  const previewDifference = previewData
    ? Number(closingBalance || 0) + Number(previewData.outstandingNet || 0) - Number(previewData.soldeComptable || 0)
    : 0;

  const updateMapping = (key, value) => {
    setCsvMapping((current) => ({ ...current, [key]: value }));
    setPreviewData(null);
    setStatementLines([]);
    setSelectedTransactions({});
    setPageError('');
  };

  const clearPreview = () => {
    setPreviewData(null);
    setStatementLines([]);
    setSelectedTransactions({});
  };

  const chooseFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setPageError('');
    setNotice('');
    setCsvIssues([]);
    setCsvDoc(null);
    setPreviewData(null);
    setStatementLines([]);
    setSelectedTransactions({});
    setFileLabel('');
    setClosingBalance('');
    setNotes('');
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setPageError(t('Le fichier dépasse 2 Mo. Exportez une période plus courte.', 'The file exceeds 2 MB. Export a shorter period.'));
      return;
    }
    try {
      const content = await file.text();
      const document = parseCsvDocument(content);
      const mapping = suggestCsvMapping(document.headers);
      const mappedAmount = mapping.amount !== '';
      const mappedSplit = mapping.debit !== '' && mapping.credit !== '';
      if (mappedAmount && mappedSplit) {
        mapping.amount = '';
        mapping.debit = '';
        mapping.credit = '';
      }
      setCsvDoc(document);
      setCsvMapping(mapping);
      setFileLabel(file.name);
      setNotice(t(`${document.rows.length} lignes lues dans le navigateur. Le fichier d’origine n’est pas conservé.`, `${document.rows.length} rows read in your browser. The original file is not retained.`));
    } catch (error) {
      setPageError(errorMessage(error, t('Impossible de lire ce fichier CSV.', 'Could not read this CSV file.')));
    }
  };

  const runPreview = async () => {
    setPageError('');
    setNotice('');
    setCsvIssues([]);
    if (!online) { setPageError(t('La prévisualisation nécessite une connexion. Vos données ne seront pas envoyées hors connexion.', 'Preview requires a connection. Your data will not be sent while offline.')); return; }
    if (!accountId) { setPageError(t('Choisissez un compte bancaire.', 'Choose a bank account.')); return; }
    if (!dateStart || !dateEnd || dateStart > dateEnd) { setPageError(t('Vérifiez les dates de début et de fin.', 'Check the start and end dates.')); return; }
    if (!csvDoc) { setPageError(t('Importez d’abord un fichier CSV de relevé.', 'Import a statement CSV first.')); return; }
    const result = validateMappedRows(csvDoc, csvMapping);
    setCsvIssues(result.issues);
    if (result.issues.length || !result.lines.length) {
      setPageError(t('Corrigez les colonnes ou les lignes signalées avant de lancer la prévisualisation.', 'Fix the selected columns or flagged rows before previewing.'));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        compteBancaireId: Number(accountId),
        dateDebut: dateStart,
        dateFin: dateEnd,
        ...(closingBalance !== '' ? { soldeReleve: Number(closingBalance) } : {}),
        statementLines: result.lines,
      };
      const response = await api.post('/bank-reconciliations/preview', payload);
      const data = responseData(response);
      setStatementLines(data.lines || []);
      setPreviewData(data);
      setSelectedTransactions({});
      setNotice(t('Prévisualisation prête. Chaque rapprochement proposé doit être confirmé manuellement.', 'Preview is ready. Every suggested match must be confirmed manually.'));
    } catch (error) {
      setPageError(errorMessage(error, t('La prévisualisation a échoué. Vérifiez la connexion puis réessayez.', 'Preview failed. Check your connection and try again.')));
    } finally { setBusy(false); }
  };

  const saveReconciliation = async () => {
    setPageError('');
    if (!online) { setPageError(t('L’enregistrement du rapprochement nécessite une connexion.', 'Saving a reconciliation requires a connection.')); return; }
    if (!previewData || closingBalance === '' || !Number.isFinite(Number(closingBalance))) {
      setPageError(t('Saisissez le solde de clôture du relevé avant d’enregistrer.', 'Enter the statement closing balance before saving.'));
      return;
    }
    setBusy(true);
    try {
      const response = await api.post('/bank-reconciliations', {
        compteBancaireId: Number(accountId),
        dateDebut: dateStart,
        dateFin: dateEnd,
        soldeReleve: Number(closingBalance),
        notes: notes.trim(),
        statementLines: statementLines.map((line) => ({
          lineNumber: line.lineNumber, date: line.date, description: line.description,
          reference: line.reference || '', amount: Number(line.amount),
          transactionId: selectedTransactions[line.lineNumber] ? Number(selectedTransactions[line.lineNumber]) : null,
        })),
      });
      const created = responseData(response);
      setNotice(t('Rapprochement enregistré en revue. Aucune écriture comptable n’a été créée automatiquement.', 'Reconciliation saved for review. No accounting entries were created automatically.'));
      setPreviewData(null);
      setStatementLines([]);
      setCsvDoc(null);
      setFileLabel('');
      setSelectedTransactions({});
      setClosingBalance('');
      setNotes('');
      setActiveTab('history');
      await loadHistory();
      onChanged?.();
      if (created?.reconciliation?.id) openDetail(created.reconciliation.id);
    } catch (error) {
      setPageError(errorMessage(error, t('Le rapprochement n’a pas été enregistré. Réessayez.', 'The reconciliation was not saved. Please try again.')));
    } finally { setBusy(false); }
  };

  const openDetail = async (id) => {
    setDetailId(id);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await api.get(`/bank-reconciliations/${id}`);
      setDetail(responseData(response));
    } catch (error) {
      setDetailError(errorMessage(error, t('Le détail ne peut pas être chargé.', 'Details could not be loaded.')));
    } finally { setDetailLoading(false); }
  };

  const changeSavedMatch = async (reconciliationId, lineId, transactionId) => {
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.put(`/bank-reconciliations/${reconciliationId}/lines/${lineId}`, { transactionId: transactionId ? Number(transactionId) : null });
      const response = await api.get(`/bank-reconciliations/${reconciliationId}`);
      setDetail(responseData(response));
      await loadHistory();
    } catch (error) {
      setDetailError(errorMessage(error, t('Le rapprochement de cette ligne a échoué.', 'Could not update this line match.')));
    } finally { setDetailBusy(false); }
  };

  const validateSaved = async () => {
    const reconciliation = detail?.reconciliation;
    if (!reconciliation || !online) return;
    const unmatched = (detail.lines || []).filter((line) => !line.transactionId).length;
    if (unmatched) { setDetailError(t('Rapprochez chaque ligne avant de valider la période.', 'Match every statement line before validating the period.')); return; }
    if (Math.abs(Number(reconciliation.ecart || 0)) > 0.01) { setDetailError(t('L’écart doit être nul avant validation. Vérifiez le solde de clôture et les lignes rapprochées.', 'The difference must be zero before validation. Review the closing balance and matched lines.')); return; }
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.post(`/bank-reconciliations/${reconciliation.id}/validate`, {});
      const response = await api.get(`/bank-reconciliations/${reconciliation.id}`);
      setDetail(responseData(response));
      await loadHistory();
      onChanged?.();
    } catch (error) {
      setDetailError(errorMessage(error, t('La validation n’a pas abouti. Vérifiez les lignes puis réessayez.', 'Validation failed. Review the lines and try again.')));
    } finally { setDetailBusy(false); }
  };

  const saveBankAccount = async (event) => {
    event.preventDefault();
    setPageError('');
    if (!online) { setPageError(t('La création du compte nécessite une connexion.', 'Creating a bank account requires a connection.')); return; }
    setBusy(true);
    try {
      const response = await api.post('/bank-reconciliations/accounts', {
        nomCompte: accountForm.nomCompte.trim(),
        banque: accountForm.banque.trim(),
        numeroCompte: accountForm.numeroCompte.trim(),
      });
      const created = responseData(response);
      setAccountModalOpen(false);
      setAccountForm({ nomCompte: '', banque: '', numeroCompte: '' });
      await loadAccounts();
      if (created?.account?.id) setAccountId(String(created.account.id));
      setNotice(t('Compte bancaire ajouté.', 'Bank account added.'));
      onChanged?.();
    } catch (error) {
      setPageError(errorMessage(error, t('Le compte bancaire n’a pas été créé.', 'The bank account was not created.')));
    } finally { setBusy(false); }
  };

  const discardDraft = async () => {
    const reconciliation = detail?.reconciliation;
    if (!reconciliation || !online) return;
    if (!window.confirm(t('Supprimer ce rapprochement en cours et ses lignes importées ?', 'Delete this draft reconciliation and its imported lines?'))) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.request(`/bank-reconciliations/${reconciliation.id}`, { method: 'DELETE' });
      setDetail(null);
      setDetailId(null);
      await loadHistory();
    } catch (error) {
      setDetailError(errorMessage(error, t('Le rapprochement n’a pas été supprimé.', 'The reconciliation was not deleted.')));
    } finally { setDetailBusy(false); }
  };

  const clearImport = () => {
    setCsvDoc(null); setFileLabel(''); setPreviewData(null); setStatementLines([]); setCsvIssues([]);
    setSelectedTransactions({}); setPageError(''); setNotice('');
    setCsvMapping({ date: '', description: '', amount: '', debit: '', credit: '', reference: '' });
  };

  const accountName = (item) => item?.nomCompte || item?.banque || t('Compte bancaire', 'Bank account');
  const renderMappingSelect = (key, label, required = false) => <label className="br-field" key={key}>
    <span>{label}{required ? ' *' : ''}</span>
    <select value={csvMapping[key]} onChange={(event) => updateMapping(key, event.target.value)} data-testid={`select-csv-${key}`}>
      <option value="">{t('Choisir une colonne', 'Choose a column')}</option>
      {csvDoc?.headers.map((header, index) => <option value={String(index)} key={`${key}-${index}`}>{header || `${t('Colonne', 'Column')} ${index + 1}`}</option>)}
    </select>
  </label>;

  return <div className="bank-recon">
    <header className="br-heading">
      <div><span className="br-kicker">{t('Trésorerie · contrôle', 'Cash flow · review')}</span>
        <h1>{t('Rapprochement bancaire', 'Bank reconciliation')}</h1>
        <p>{t('Reliez les mouvements du relevé aux opérations déjà saisies. Chaque proposition reste à confirmer.', 'Link statement movements to transactions already recorded. Every suggestion still needs your confirmation.')}</p>
      </div>
        <div className="br-heading-note">
          <button type="button" className="br-button" onClick={() => { setPageError(''); setAccountModalOpen(true); }} data-testid="button-add-bank-account">{t('Ajouter un compte', 'Add account')}</button>
          <strong>{t('Revue manuelle', 'Manual review')}</strong>{t('Aucune écriture ni opération n’est créée automatiquement.', 'No accounting entry or transaction is created automatically.')}
        </div>
    </header>

    <section className="br-overview" aria-label={t('Résumé des rapprochements', 'Reconciliation overview')}>
      <div className="br-overview-main"><span>{t('Périodes à vérifier', 'Periods to review')}</span>
        <strong>{history.filter((item) => !['valide', 'validee', 'validated', 'validé', 'validée'].includes(String(item.statut || '').toLowerCase())).length}</strong>
      </div>
      <div className="br-stat"><span>{t('Comptes actifs', 'Active accounts')}</span><strong>{accountsLoading ? '—' : activeAccounts.length}</strong></div>
      <div className="br-stat"><span>{t('Rapprochements enregistrés', 'Saved reconciliations')}</span><strong>{historyLoading ? '—' : history.length}</strong></div>
    </section>

    {!online && <div className="br-info" role="status" data-testid="status-reconciliation-offline">{t('Hors connexion : l’aperçu et l’enregistrement sont désactivés. Le fichier importé reste seulement dans cet écran.', 'Offline: preview and saving are disabled. The imported file remains only on this screen.')}</div>}
    {notice && <div className="br-success" role="status" data-testid="message-reconciliation-success">{notice}</div>}
    {pageError && <div className="br-error" role="alert" data-testid="error-reconciliation">{pageError}</div>}

    <div className="br-workspace">
      <section className="br-main-panel">
        <div className="br-panel-head">
          <div><h2>{activeTab === 'new' ? t('Préparer une période', 'Prepare a period') : t('Rapprochements enregistrés', 'Saved reconciliations')}</h2>
            <p>{activeTab === 'new' ? t('Import local, contrôle des colonnes, puis rapprochement ligne par ligne.', 'Local import, column check, then line-by-line matching.') : t('Ouvrez une période pour reprendre ou terminer votre revue.', 'Open a period to continue or complete your review.')}</p></div>
          <div className="br-tab-row" role="tablist" aria-label={t('Sections du rapprochement', 'Reconciliation sections')}>
            <button type="button" role="tab" aria-selected={activeTab === 'new'} className={activeTab === 'new' ? 'active' : ''} onClick={() => setActiveTab('new')} data-testid="tab-reconciliation-new">{t('Nouveau', 'New')}</button>
            <button type="button" role="tab" aria-selected={activeTab === 'history'} className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')} data-testid="tab-reconciliation-history">{t('Historique', 'History')} · {history.length}</button>
          </div>
        </div>

        {activeTab === 'new' ? <>
          {accountsLoading ? <Skeleton /> : accountsError ? <div className="br-error" role="alert" data-testid="error-bank-accounts">
            <span>{accountsError}</span> <button type="button" className="br-button" onClick={loadAccounts} data-testid="button-retry-bank-accounts">{t('Réessayer', 'Try again')}</button>
          </div> : activeAccounts.length === 0 ? <div className="br-history-empty" data-testid="empty-bank-accounts">
            <strong>{t('Aucun compte bancaire actif.', 'No active bank accounts.')}</strong><br />{t('Ajoutez un compte bancaire pour commencer le rapprochement.', 'Add a bank account to start reconciling.')}
            <p><button type="button" className="br-button br-button-primary" onClick={() => setAccountModalOpen(true)} data-testid="button-add-first-bank-account">{t('Créer un compte bancaire', 'Create a bank account')}</button></p>
          </div> : <div className="br-form">
            <div className="br-fields">
              <label className="br-field"><span>{t('Compte bancaire', 'Bank account')} *</span>
                <select value={accountId} onChange={(event) => { setAccountId(event.target.value); clearPreview(); }} data-testid="select-reconciliation-account">
                  {activeAccounts.map((account) => <option key={account.id} value={account.id}>{accountName(account)}{account.banque && account.nomCompte ? ` · ${account.banque}` : ''}</option>)}
                </select>
              </label>
              <label className="br-field"><span>{t('Début de période', 'Period start')} *</span><input type="date" value={dateStart} onChange={(event) => { setDateStart(event.target.value); clearPreview(); }} data-testid="input-reconciliation-start" /></label>
              <label className="br-field"><span>{t('Fin de période', 'Period end')} *</span><input type="date" value={dateEnd} onChange={(event) => { setDateEnd(event.target.value); clearPreview(); }} data-testid="input-reconciliation-end" /></label>
            </div>
            <div className="br-upload-zone">
              <span className="br-upload-mark" aria-hidden="true">CSV</span>
              <div className="br-upload-copy"><strong>{fileLabel || t('Importer le relevé bancaire', 'Import bank statement')}</strong>
                <span>{t('CSV · jusqu’à 2 Mo et 5 000 lignes · lu uniquement dans ce navigateur', 'CSV · up to 2 MB and 5,000 rows · read only in this browser')}</span></div>
              <label className="br-button" htmlFor="br-csv-file" data-testid="button-choose-csv">{t('Choisir un fichier', 'Choose file')}</label>
              <input className="br-sr-only" id="br-csv-file" type="file" accept=".csv,text/csv,.txt,text/plain" onChange={chooseFile} data-testid="input-reconciliation-csv" />
            </div>
            {csvDoc && <div className="br-mapping" data-testid="panel-csv-mapping">
              <div className="br-mapping-head"><strong>{t('Associer les colonnes', 'Map the columns')}</strong><span className="br-chip">{csvDoc.rows.length} {t('lignes', 'rows')}</span></div>
              <div className="br-mapping-grid">
                {renderMappingSelect('date', t('Date', 'Date'), true)}
                {renderMappingSelect('description', t('Description / libellé', 'Description / label'), true)}
                {renderMappingSelect('amount', t('Montant signé', 'Signed amount'))}
                {renderMappingSelect('debit', t('Débit', 'Debit'))}
                {renderMappingSelect('credit', t('Crédit', 'Credit'))}
                {renderMappingSelect('reference', t('Référence (facultatif)', 'Reference (optional)'))}
              </div>
              {csvIssues.length > 0 && <div className="br-row-issues" role="alert" data-testid="list-csv-issues">{csvIssues.slice(0, 8).map((issue) => <div key={issue}>{issue}</div>)}{csvIssues.length > 8 && <div>+ {csvIssues.length - 8} {t('autres lignes à corriger', 'more rows to fix')}</div>}</div>}
              {!csvIssues.length && mappingResult.issues.length > 0 && <div className="br-row-issues" data-testid="message-csv-mapping">{mappingResult.issues[0]}</div>}
              {!csvIssues.length && !mappingResult.issues.length && <div className="br-note">{t('Les crédits sont positifs, les débits négatifs. Les montants et dates sont vérifiés avant l’aperçu.', 'Credits are positive and debits negative. Amounts and dates are checked before preview.')}</div>}
            </div>}
            <div className="br-review-bottom">
              <p>{t('Le rapprochement compare le relevé aux opérations existantes ; il ne publie aucune écriture.', 'This review compares the statement with existing transactions; it does not post entries.')}</p>
              <div className="br-review-actions">
                {csvDoc && <button type="button" className="br-button" onClick={clearImport} data-testid="button-clear-csv">{t('Retirer le fichier', 'Remove file')}</button>}
                <button type="button" className="br-button br-button-primary" onClick={runPreview} disabled={!online || busy || !csvDoc} data-testid="button-preview-reconciliation">
                  {busy ? t('Préparation…', 'Preparing…') : t('Prévisualiser les lignes', 'Preview statement lines')}
                </button>
              </div>
            </div>
          </div>}

          {previewData && <div className="br-form" data-testid="panel-reconciliation-preview">
            <div className="br-panel-head" style={{ padding: '0 0 13px', borderBottom: '0' }}>
              <div><h2>{t('Revue des lignes', 'Statement line review')}</h2><p>{t('Une suggestion n’est qu’une aide : choisissez explicitement chaque opération à rapprocher.', 'A suggestion is only a hint: explicitly choose each transaction to match.')}</p></div>
              <span className="br-chip">{statementLines.length} {t('lignes', 'lines')}</span>
            </div>
            <div className="br-fields" style={{ gridTemplateColumns: 'minmax(220px,1fr) minmax(220px,1fr)' }}>
              <label className="br-field"><span>{t('Solde de clôture du relevé', 'Statement closing balance')} *</span>
                <input type="number" step="0.01" value={closingBalance} onChange={(event) => setClosingBalance(event.target.value)} placeholder="0" data-testid="input-statement-closing-balance" />
              </label>
              <label className="br-field"><span>{t('Note de revue (facultatif)', 'Review note (optional)')}</span>
                <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} placeholder={t('Ex. frais bancaires à vérifier', 'E.g. bank fees to review')} data-testid="input-reconciliation-notes" />
              </label>
            </div>
            <div className="br-preview-summary">
              <span className="br-chip match">{matchedCount} {t('confirmés', 'confirmed')}</span>
              <span className="br-chip unmatched">{statementLines.length - matchedCount} {t('sans rapprochement', 'unmatched')}</span>
              <span className="br-chip">{t('Solde comptable', 'Book balance')}: {amountValue(previewData.soldeComptable, currency, language)}</span>
              {closingBalance !== '' && <span className={`br-chip ${Math.abs(previewDifference) < .01 ? 'match' : 'unmatched'}`}>{t('Écart', 'Difference')}: {amountValue(previewDifference, currency, language)}</span>}
            </div>
            <div className="br-table-wrap">
              <table className="br-table">
                <thead><tr><th>{t('Date · libellé', 'Date · description')}</th><th className="num">{t('Montant', 'Amount')}</th><th>{t('Opération comptable', 'Book transaction')}</th></tr></thead>
                <tbody>{statementLines.map((line, index) => {
                  const selected = selectedTransactions[line.lineNumber] || '';
                  const transactions = previewData.transactions || [];
                  const suggestion = line.suggestedTransactionId ? transactions.find((entry) => Number(entry.id) === Number(line.suggestedTransactionId)) : null;
                  return <tr key={`${line.lineNumber}-${index}`} data-testid={`row-preview-line-${line.lineNumber}`}>
                    <td><span className="br-line-desc" title={line.description}>{line.description}</span><span className="br-line-ref">{dateLabel(line.date, language)}{line.reference ? ` · ${line.reference}` : ''}</span></td>
                    <td className="num">{amountValue(line.amount, currency, language)}</td>
                    <td><div className="br-match-picker">
                      <select value={selected} onChange={(event) => setSelectedTransactions((current) => ({ ...current, [line.lineNumber]: event.target.value }))} aria-label={t(`Opération pour la ligne ${line.lineNumber}`, `Transaction for line ${line.lineNumber}`)} data-testid={`select-match-line-${line.lineNumber}`}>
                        <option value="">{t('Laisser sans rapprochement', 'Leave unmatched')}</option>
                        {transactions.map((transaction) => <option key={transaction.id} value={transaction.id} disabled={
                  (transaction.rapproche && Number(transaction.id) !== Number(selectedTransactions[line.lineNumber]))
                          || Object.entries(selectedTransactions).some(([otherLine, selectedId]) => otherLine !== String(line.lineNumber) && String(selectedId) === String(transaction.id))
                        }>
                          {dateLabel(transaction.dateTransaction, language)} · {transaction.description || transaction.numeroPiece || `#${transaction.id}`} · {amountValue(transaction.montantSigne ?? transaction.montant, currency, language)}
                        </option>)}
                      </select>
                      {suggestion && !selected && <span className="br-suggestion">{line.suggestionReason || t('Correspondance suggérée', 'Suggested match')} · <button type="button" onClick={() => setSelectedTransactions((current) => ({ ...current, [line.lineNumber]: String(suggestion.id) }))} data-testid={`button-confirm-suggestion-${line.lineNumber}`}>{t('Confirmer cette suggestion', 'Confirm suggestion')}</button></span>}
                      {selected && <span className="br-match-state">{t('Rapprochement confirmé', 'Match confirmed')} <button type="button" className="br-button br-button-quiet" onClick={() => setSelectedTransactions((current) => ({ ...current, [line.lineNumber]: '' }))} data-testid={`button-unmatch-line-${line.lineNumber}`}>{t('Retirer', 'Unmatch')}</button></span>}
                      {!selected && !suggestion && <span className="br-unmatched-state">{t('À examiner', 'Needs review')}</span>}
                    </div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <div className="br-review-bottom">
              <p>{t('Les lignes non rapprochées restent dans le dossier et pourront être revues plus tard.', 'Unmatched lines stay in the record and can be reviewed later.')}</p>
              <button type="button" className="br-button br-button-primary" onClick={saveReconciliation} disabled={busy || !online || closingBalance === ''} data-testid="button-save-reconciliation">
                {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer pour revue', 'Save for review')}
              </button>
            </div>
          </div>}
        </> : <div className="br-history-list">
          {historyLoading ? <Skeleton /> : historyError ? <div className="br-error" role="alert" data-testid="error-reconciliation-history">{historyError}
            <button type="button" className="br-button" onClick={loadHistory} data-testid="button-retry-reconciliation-history">{t('Réessayer', 'Try again')}</button></div> : history.length ? [...history].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((item) =>
            <button type="button" className="br-history-item" key={item.id} onClick={() => openDetail(item.id)} data-testid={`button-open-reconciliation-${item.id}`}>
              <span className="br-history-top"><strong>{item.nomCompte || accountName(accounts.find((account) => Number(account.id) === Number(item.compteBancaireId)))}</strong>
                <span className={`br-status ${String(item.statut || '').toLowerCase()}`}>{statusLabel(item.statut, t)}</span></span>
              <span className="br-history-meta">{dateLabel(item.dateDebut, language)} — {dateLabel(item.dateFin, language)} · {t('Écart', 'Difference')} {amountValue(item.ecart, currency, language)}</span>
            </button>
          ) : <EmptyHistory t={t} />}
          {!historyLoading && !historyError && <button type="button" className="br-button" style={{ margin: '12px 8px 0' }} onClick={loadHistory} data-testid="button-refresh-reconciliation-history">{t('Actualiser l’historique', 'Refresh history')}</button>}
        </div>}
      </section>

      <aside className="br-history-panel">
        <div className="br-panel-head"><div><h2>{t('À reprendre', 'Continue review')}</h2><p>{t('Périodes récentes', 'Recent periods')}</p></div>
          <button type="button" className="br-button br-button-quiet" onClick={() => setActiveTab('history')} data-testid="button-view-all-reconciliations">{t('Tout voir', 'View all')}</button>
        </div>
        {historyLoading ? <Skeleton /> : historyError ? <div className="br-history-empty">{historyError}<br /><button type="button" className="br-button" onClick={loadHistory} data-testid="button-retry-history-side">{t('Réessayer', 'Try again')}</button></div>
          : history.length ? <div className="br-history-list">{[...history].slice(0, 4).map((item) => <button type="button" className="br-history-item" key={item.id} onClick={() => openDetail(item.id)} data-testid={`button-recent-reconciliation-${item.id}`}>
            <span className="br-history-top"><strong>{item.nomCompte || accountName(accounts.find((account) => Number(account.id) === Number(item.compteBancaireId)))}</strong><span className={`br-status ${String(item.statut || '').toLowerCase()}`}>{statusLabel(item.statut, t)}</span></span>
            <span className="br-history-meta">{dateLabel(item.dateDebut, language)} — {dateLabel(item.dateFin, language)}<br />{t('Solde relevé', 'Statement balance')}: {amountValue(item.soldeReleve, currency, language)}</span>
          </button>)}</div> : <EmptyHistory t={t} />}
        <div className="br-info" style={{ margin: '0 12px 12px' }}>{t('Le relevé sert de référence. Toute opération manquante doit être saisie séparément dans votre comptabilité.', 'The statement is a reference. Any missing transaction must be entered separately in your books.')}</div>
      </aside>
    </div>

    {(detailLoading || detail || detailError) && <div className="br-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !detailBusy) { setDetail(null); setDetailError(''); } }}>
      <section className="br-modal" role="dialog" aria-modal="true" aria-label={t('Détail du rapprochement', 'Reconciliation details')}>
        <header className="br-modal-head"><h2>{t('Détail du rapprochement', 'Reconciliation details')}</h2><button type="button" onClick={() => { setDetail(null); setDetailError(''); }} aria-label={t('Fermer', 'Close')} data-testid="button-close-reconciliation-detail">×</button></header>
        {detailLoading ? <Skeleton /> : detailError && !detail ? <div className="br-error" role="alert">{detailError}<button type="button" className="br-button" onClick={() => detailId && openDetail(detailId)} data-testid="button-retry-reconciliation-detail">{t('Réessayer', 'Try again')}</button></div> : detail && <div className="br-modal-body">
          {!online && <div className="br-offline">{t('Hors connexion : la revue détaillée est en lecture seule.', 'Offline: detailed review is read-only.')}</div>}
          <div className="br-detail-summary">
            <div><span>{t('Compte', 'Account')}</span><strong>{detail.reconciliation?.nomCompte || accountName(accounts.find((account) => Number(account.id) === Number(detail.reconciliation?.compteBancaireId)))}</strong></div>
            <div><span>{t('Période', 'Period')}</span><strong>{dateLabel(detail.reconciliation?.dateDebut, language)} — {dateLabel(detail.reconciliation?.dateFin, language)}</strong></div>
            <div><span>{t('Écart', 'Difference')}</span><strong>{amountValue(detail.reconciliation?.ecart, currency, language)}</strong></div>
          </div>
          {detailError && <div className="br-error" role="alert" data-testid="error-reconciliation-detail">{detailError}</div>}
          <div className="br-table-wrap">
            <table className="br-table">
              <thead><tr><th>{t('Ligne du relevé', 'Statement line')}</th><th className="num">{t('Montant', 'Amount')}</th><th>{t('Rapprochement confirmé', 'Confirmed match')}</th></tr></thead>
              <tbody>{(detail.lines || []).map((line, index) => {
                const transactionId = line.transactionId ?? line.transaction_id ?? '';
                const lineId = line.id ?? line.lineId ?? line.lineNumber ?? index;
                return <tr key={lineId} data-testid={`row-saved-line-${lineId}`}>
                  <td><span className="br-line-desc">{line.description}</span><span className="br-line-ref">{dateLabel(line.date, language)}{line.reference ? ` · ${line.reference}` : ''}</span></td>
                  <td className="num">{amountValue(line.amount, currency, language)}</td>
                <td><div className="br-match-picker"><select disabled={!online || detailBusy || ['valide', 'validee', 'validated', 'validé', 'validée'].includes(String(detail.reconciliation?.statut || '').toLowerCase())}
                    value={transactionId ? String(transactionId) : ''} onChange={(event) => changeSavedMatch(detail.reconciliation.id, lineId, event.target.value)} data-testid={`select-saved-match-${lineId}`}>
                    <option value="">{t('Sans rapprochement', 'Unmatched')}</option>
                    {(detail.transactions || []).map((transaction) => {
                      const assignedElsewhere = (detail.lines || []).some((otherLine, otherIndex) => {
                        const otherId = otherLine.transactionId ?? otherLine.transaction_id ?? '';
                        const otherLineId = otherLine.id ?? otherLine.lineId ?? otherLine.lineNumber ?? otherIndex;
                        return String(otherLineId) !== String(lineId) && String(otherId) === String(transaction.id);
                      });
                      return <option key={transaction.id} value={transaction.id} disabled={assignedElsewhere || (transaction.rapproche && String(transaction.id) !== String(transactionId))}>
                        {dateLabel(transaction.dateTransaction, language)} · {transaction.description || transaction.numeroPiece || `#${transaction.id}`} · {amountValue(transaction.montantSigne ?? transaction.montant, currency, language)}
                      </option>;
                    })}
                  </select>{transactionId ? <span className="br-match-state">{t('Confirmé', 'Confirmed')}</span> : <span className="br-unmatched-state">{t('À examiner', 'Needs review')}</span>}</div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <p className="br-note">{t('Les lignes non rapprochées restent visibles. Aucun mouvement comptable n’est créé depuis cet écran.', 'Unmatched statement lines remain visible. This screen does not create accounting transactions.')}</p>
          <div className="br-review-bottom">
            <span className={`br-status ${String(detail.reconciliation?.statut || '').toLowerCase()}`}>{statusLabel(detail.reconciliation?.statut, t)}</span>
            <div className="br-review-actions">
            {!['valide', 'validee', 'validated', 'validé', 'validée'].includes(String(detail.reconciliation?.statut || '').toLowerCase()) && <button type="button" className="br-button" disabled={!online || detailBusy} onClick={discardDraft} data-testid="button-delete-reconciliation">{t('Supprimer le brouillon', 'Delete draft')}</button>}
            <button type="button" className="br-button br-button-primary" disabled={!online || detailBusy || ['valide', 'validee', 'validated', 'validé', 'validée'].includes(String(detail.reconciliation?.statut || '').toLowerCase())}
              onClick={validateSaved} data-testid="button-validate-reconciliation">{detailBusy ? t('Mise à jour…', 'Updating…') : t('Valider la période', 'Validate period')}</button>
            </div>
          </div>
        </div>}
      </section>
    </div>}
    {accountModalOpen && <div className="br-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setAccountModalOpen(false); }}>
      <section className="br-modal" role="dialog" aria-modal="true" aria-label={t('Ajouter un compte bancaire', 'Add a bank account')}>
        <header className="br-modal-head"><h2>{t('Ajouter un compte bancaire', 'Add a bank account')}</h2>
          <button type="button" onClick={() => setAccountModalOpen(false)} aria-label={t('Fermer', 'Close')} data-testid="button-close-bank-account">×</button></header>
        <form className="br-modal-body br-account-form" onSubmit={saveBankAccount}>
          <label className="br-field"><span>{t('Nom du compte', 'Account name')} *</span><input autoFocus required maxLength="255" value={accountForm.nomCompte} onChange={(event) => setAccountForm((current) => ({ ...current, nomCompte: event.target.value }))} data-testid="input-bank-account-name" /></label>
          <label className="br-field"><span>{t('Banque', 'Bank')}</span><input maxLength="255" value={accountForm.banque} onChange={(event) => setAccountForm((current) => ({ ...current, banque: event.target.value }))} data-testid="input-bank-account-bank" /></label>
          <label className="br-field"><span>{t('Numéro de compte (facultatif)', 'Account number (optional)')}</span><input maxLength="100" value={accountForm.numeroCompte} onChange={(event) => setAccountForm((current) => ({ ...current, numeroCompte: event.target.value }))} data-testid="input-bank-account-number" /></label>
          <p className="br-note">{t('Le nouveau compte commence à zéro. Un solde d’ouverture non nul doit être comptabilisé par une écriture séparée.', 'A new account starts at zero. A non-zero opening balance must be recorded as a separate accounting entry.')}</p>
          <button type="submit" className="br-button br-button-primary" disabled={busy || !online} data-testid="button-save-bank-account">{busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer le compte', 'Save account')}</button>
        </form>
      </section>
    </div>}
  </div>;
}
