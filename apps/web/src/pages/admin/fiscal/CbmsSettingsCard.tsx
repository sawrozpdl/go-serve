import { useEffect, useState } from 'react';
import { CloudUpload, PlugZap, Save } from 'lucide-react';
import type { CbmsConnectionResult, FiscalProfile } from '@cafe-mgmt/api-types';
import { useTestCbmsConnection, useUpdateCbmsCredentials } from '@/lib/api';
import { toast } from '@/lib/toast';

// The café's IRD Taxpayer Portal login, which CBMS takes with every bill
// (procedure 2082 §6.4(क), §7.2(ङ)). Bills issued before this is set up are
// queued, never lost, and post as soon as it is saved.

const MODE_TEXT: Record<FiscalProfile['cbms_mode'], string> = {
  live: 'Bills are reported to IRD’s CBMS as they are issued.',
  mock: 'Demo mode: bills go to a stand-in server, not to IRD. Nothing here counts as reported.',
  off: 'CBMS posting is off on this server. Bills are queued and will be reported once it is switched on.',
};

export function CbmsSettingsCard({ profile }: { profile: FiscalProfile }) {
  const save = useUpdateCbmsCredentials();
  const test = useTestCbmsConnection();
  const [enabled, setEnabled] = useState(profile.cbms_enabled);
  const [username, setUsername] = useState(profile.cbms_username);
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<CbmsConnectionResult | null>(null);

  useEffect(() => {
    setEnabled(profile.cbms_enabled);
    setUsername(profile.cbms_username);
  }, [profile.cbms_enabled, profile.cbms_username]);

  const dirty = enabled !== profile.cbms_enabled || username !== profile.cbms_username || password !== '';
  const c = profile.cbms_counts;

  const onSave = async () => {
    try {
      await save.mutateAsync({ enabled, username, ...(password ? { password } : {}) });
      setPassword('');
      setResult(null);
      toast.success('CBMS login saved');
    } catch (e: unknown) {
      toast.error('Could not save', (e as { message?: string }).message ?? '');
    }
  };

  const onTest = async () => {
    try {
      setResult(await test.mutateAsync());
    } catch (e: unknown) {
      toast.error('Test failed', (e as { message?: string }).message ?? '');
    }
  };

  return (
    <div className="tab-section" style={{ maxWidth: '100%' }}>
      <h2>
        <CloudUpload size={16} strokeWidth={1.6} style={{ marginRight: 6, verticalAlign: '-2px' }} />
        Reporting to IRD (CBMS)
      </h2>
      <p className="tab-sub">{MODE_TEXT[profile.cbms_mode]}</p>

      <div className="filter-row" style={{ marginBottom: 12 }}>
        <span className="pill">Reported: {c.synced}</span>
        <span className="pill">Waiting: {c.pending}</span>
        {c.failed > 0 && <span className="pill danger">Needs attention: {c.failed}</span>}
      </div>

      <div className="locale-grid">
        <div className="field">
          <label>IRD username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            placeholder="Taxpayer Portal user id"
            maxLength={120}
          />
        </div>
        <div className="field">
          <label>IRD password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={profile.cbms_password_set ? '•••••••• (saved — type to replace)' : 'Taxpayer Portal password'}
            maxLength={200}
          />
          <div className="field-hint">Stored encrypted. Update it here whenever you change it on the portal.</div>
        </div>
      </div>

      <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Report bills to CBMS with this login
      </label>

      <div className="filter-row">
        <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={onSave}>
          <Save size={14} strokeWidth={1.5} /> {save.isPending ? 'Saving…' : 'Save CBMS login'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={dirty || !profile.cbms_password_set || test.isPending}
          onClick={onTest}
          title="Sends a harmless request that IRD answers “bill does not exist” when the login is valid"
        >
          <PlugZap size={14} strokeWidth={1.5} /> {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {result && (
        <div className={result.ok ? 'banner-info' : 'banner-error'} style={{ marginTop: 10 }} role="status">
          {result.message}
          {result.code ? ` (code ${result.code})` : ''}
        </div>
      )}
    </div>
  );
}
