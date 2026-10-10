import { useEffect, useRef, useState } from 'react';
import type { OutcomeDetails, PipelineStatus } from './types';
import { stageOf, TONE_DOT } from '@/views/Pipeline/stages';

interface OutcomeDialogProps {
  open?: boolean;
  company: string;
  title: string;
  status: PipelineStatus;
  busy?: boolean;
  onSubmit: (details: OutcomeDetails) => void;
  onCancel: () => void;
}

function heading(status: PipelineStatus, company: string): string {
  if (status === 'phone' || status === 'onsite') return 'How did the interview go?';
  if (status === 'offer') return `An offer from ${company}`;
  return `Closing out ${company}`;
}

/** Optional notes for an outcome worth remembering. The stage has already moved. */
export function OutcomeDialog({ open = true, company, title, status, busy = false, onSubmit, onCancel }: OutcomeDialogProps): React.ReactNode {
  const [notes, setNotes] = useState('');
  const [rounds, setRounds] = useState(1);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stage = stageOf(status);
  const titleId = 'outcome-dialog-title';

  useEffect(() => {
    if (!open) return;
    setNotes(''); setRounds(status === 'onsite' ? 2 : 1);
    const previousFocus = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => notesRef.current?.focus({ preventScroll: true }));
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); previousFocus?.focus({ preventScroll: true }); };
  }, [open, busy, onCancel, status]);

  const submit = (): void => {
    const details: OutcomeDetails = { interviewRounds: rounds };
    if (notes.trim()) details.notes = notes.trim();
    onSubmit(details);
  };

  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
    className={`sheet form-sheet narrow ${open ? 'on' : ''}`} {...(!open ? { inert: true } : {})}>
    <div style={{ marginBottom: 12 }}>
      <span className={`pill static st-${stage.tone}`} style={{ height: 30 }}><span className="stdot" style={{ background: TONE_DOT[stage.tone] }} />{stage.label}</span>
    </div>
    <h2 id={titleId} className="sheet-title">{heading(status, company)}</h2>
    <p className="sheet-sub" style={{ marginBottom: 22 }}>{title} at {company}. Notes are optional and stay on this device.</p>
    <label style={{ display: 'block' }}>
      <span className="flab" style={{ display: 'flex', justifyContent: 'space-between' }}>What happened? <span className="tnum">{notes.length} / 400</span></span>
      <textarea ref={notesRef} className="fld" maxLength={400} value={notes} aria-label="What happened?"
        placeholder="A sentence or two you’ll want to remember." onChange={(event) => setNotes(event.target.value)} />
    </label>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
      <span className="flab" style={{ margin: 0 }} id="rounds-label">Interview rounds so far</span>
      <div className="stepper" role="group" aria-labelledby="rounds-label">
        <button type="button" className="icb" style={{ width: 36, height: 36, fontSize: 18 }} aria-label="Fewer rounds" disabled={busy || rounds <= 0} onClick={() => setRounds(r => Math.max(0, r - 1))}>−</button>
        <span aria-live="polite">{rounds}</span>
        <button type="button" className="icb" style={{ width: 36, height: 36, fontSize: 18 }} aria-label="More rounds" disabled={busy || rounds >= 20} onClick={() => setRounds(r => Math.min(20, r + 1))}>+</button>
      </div>
    </div>
    <div className="sheet-actions">
      <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Skip</button>
      <button type="button" className="solid" disabled={busy} onClick={submit} style={{ height: 42 }}>{busy ? 'Saving…' : 'Save notes'}</button>
    </div>
  </div>;
}
