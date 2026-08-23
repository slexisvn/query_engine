import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffPlans } from './engine/plan-diff.js';
import { buildMorph } from './engine/morph.js';
import { toPlanView } from './engine/plan-view.js';
import { sizePlanNode } from './ui/node-sizer.js';
import { traceQuery } from './engine/trace.js';
import { Workspace } from './engine/workspace.js';
import { DEFAULT_EXAMPLE } from './content/examples.js';
import { JsonView } from './ui/JsonView.js';
import { PaneRail } from './ui/PaneRail.js';
import { PassList } from './ui/PassList.js';
import { PassNotes } from './ui/PassNotes.js';
import { PhysicalView } from './ui/PhysicalView.js';
import { PlanGraph } from './ui/PlanGraph.js';
import { PlanText } from './ui/PlanText.js';
import { ResultsView } from './ui/ResultsView.js';
import { SchemaPanel } from './ui/SchemaPanel.js';
import { SqlEditor } from './ui/SqlEditor.js';
import { STAGES, StageRail } from './ui/StageRail.js';
import { TopBar } from './ui/TopBar.js';
import { Transport } from './ui/Transport.js';
import { useMediaQuery } from './ui/useMediaQuery.js';
import { useReducedMotion, useTween } from './ui/useTween.js';
import { formatCount } from './ui/format.js';
import { dropLegacyHash, readSession, writeSession } from './session-state.js';
import type { PlanViewNode } from './engine/plan-view.js';
import type { OptimizeTrace, PassStep } from './engine/trace.js';
import type { PaneKind } from './ui/PaneRail.js';
import type { RunOutcome } from './engine/workspace.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { StageKind } from './ui/StageRail.js';

const MORPH_DURATION_MS = 700;
const COMPACT_LAYOUT = '(max-width: 1000px)';

type PlanTab = 'tree' | 'text';

interface Submission {
  sql: string;
  statistics: Map<string, TableStats>;
  version: number;
}

function firstChangedFrom(steps: readonly PassStep[], start: number): number | null {
  for (let index = start; index < steps.length; index++) {
    if (steps[index].changed) return index;
  }
  return null;
}

function lastChangedBefore(steps: readonly PassStep[], start: number): number | null {
  for (let index = Math.min(start, steps.length) - 1; index >= 0; index--) {
    if (steps[index].changed) return index;
  }
  return null;
}

function bootstrap(): { workspace: Workspace; sql: string } {
  dropLegacyHash();
  const workspace = new Workspace();
  const saved = readSession();
  if (saved) {
    for (const [table, rowCount] of Object.entries(saved.rowCounts)) workspace.setRowCount(table, rowCount);
  }
  return { workspace, sql: saved?.sql ?? DEFAULT_EXAMPLE.sql };
}

export function App() {
  const start = useMemo(bootstrap, []);
  const workspace = start.workspace;

  const [sql, setSql] = useState(start.sql);
  const [submission, setSubmission] = useState<Submission>(
    () => ({ sql: start.sql, statistics: start.workspace.statistics(), version: start.workspace.version }),
  );
  const [catalogVersion, setCatalogVersion] = useState(workspace.version);
  const [stage, setStage] = useState<StageKind>('optimize');
  const [pane, setPane] = useState<PaneKind>('stages');
  const [subjectIndex, setSubjectIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [hideNoops, setHideNoops] = useState(true);
  const [tab, setTab] = useState<PlanTab>('tree');
  const [spotlight, setSpotlight] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [chaining, setChaining] = useState(false);
  const [selected, setSelected] = useState<PlanViewNode | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [result, setResult] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const compact = useMediaQuery(COMPACT_LAYOUT);
  const statistics = useMemo(() => workspace.statistics(), [workspace, catalogVersion]);
  const tables = useMemo(() => workspace.tables(), [workspace, catalogVersion]);
  const rowCounts = useMemo(() => workspace.sampleRowCounts(), [workspace, catalogVersion]);
  const usesSampleSchema = useMemo(() => workspace.usesSampleSchema, [workspace, catalogVersion]);
  const loadedRows = useMemo(
    () => tables.reduce((total, table) => (table.kind === 'imported' ? total + table.rowCount : total), 0),
    [tables],
  );

  const outcome = useMemo(
    () => traceQuery(submission.sql, workspace.catalog, submission.statistics),
    [submission, workspace],
  );

  useEffect(() => writeSession({ sql, rowCounts }), [sql, rowCounts]);

  const trace = outcome.ok ? outcome.trace : null;
  const subject = trace?.subjects[Math.min(subjectIndex, trace.subjects.length - 1)] ?? null;
  const optimize: OptimizeTrace | null = subject?.optimize ?? null;

  useEffect(() => {
    if (!optimize) return;
    setSubjectIndex(current => (trace && current < trace.subjects.length ? current : 0));
    setStepIndex(firstChangedFrom(optimize.steps, 0) ?? 0);
    setSelected(null);
  }, [optimize, trace]);

  const reducedMotion = useReducedMotion();
  const tween = useTween(MORPH_DURATION_MS / speed, !reducedMotion);
  const step = optimize?.steps[stepIndex] ?? null;

  const morph = useMemo(() => {
    if (!optimize) return null;
    const beforePlan = step ? optimize.snapshots[step.from].display : optimize.snapshots[0].display;
    const afterPlan = step ? optimize.snapshots[step.to].display : optimize.snapshots[0].display;
    const before = toPlanView(beforePlan);
    const after = toPlanView(afterPlan);
    return buildMorph(before, after, diffPlans(before, after), sizePlanNode);
  }, [optimize, step]);

  const planStageMorph = useMemo(() => {
    if (!optimize) return null;
    const view = toPlanView(optimize.snapshots[0].display);
    return buildMorph(view, view, diffPlans(view, view), sizePlanNode);
  }, [optimize]);

  const chainRef = useRef(false);
  const stepRef = useRef(stepIndex);
  const playRef = useRef(tween.play);
  const sqlRef = useRef(sql);
  const busyRef = useRef(false);
  stepRef.current = stepIndex;
  playRef.current = tween.play;
  chainRef.current = chaining;
  sqlRef.current = sql;

  useEffect(() => {
    if (!optimize || stage !== 'optimize') return;
    playRef.current(() => {
      if (!chainRef.current) return;
      const next = firstChangedFrom(optimize.steps, stepRef.current + 1);
      if (next === null) {
        setChaining(false);
        return;
      }
      setStepIndex(next);
    });
  }, [optimize, stage, stepIndex]);

  const runQuery = useCallback(async () => {
    if (busyRef.current) return;
    const pending = sqlRef.current;
    busyRef.current = true;
    setSubmission({ sql: pending, statistics: workspace.statistics(), version: workspace.version });
    setPane(current => (current === 'query' ? 'stages' : current));
    setRunning(true);
    const ran = await workspace.run(pending);
    setResult(ran);
    setRunning(false);
    busyRef.current = false;
  }, [workspace]);

  const importFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return;
    setImporting(true);
    let failure: string | null = null;
    for (const file of files) {
      const imported = await workspace.importCsv(file.name, await file.text());
      if (!imported.ok) failure = imported.message;
    }
    setImportError(failure);
    setCatalogVersion(workspace.version);
    setImporting(false);
  }, [workspace]);

  const selectStep = useCallback((index: number) => {
    setStepIndex(index);
    setStage('optimize');
    setPane('stages');
  }, []);

  const goPrevious = useCallback(() => {
    if (!optimize) return;
    const target = hideNoops ? lastChangedBefore(optimize.steps, stepIndex) : stepIndex - 1;
    if (target !== null && target >= 0) selectStep(target);
  }, [hideNoops, optimize, selectStep, stepIndex]);

  const goNext = useCallback(() => {
    if (!optimize) return;
    const target = hideNoops ? firstChangedFrom(optimize.steps, stepIndex + 1) : stepIndex + 1;
    if (target !== null && target < optimize.steps.length) selectStep(target);
  }, [hideNoops, optimize, selectStep, stepIndex]);

  const togglePlay = useCallback(() => {
    if (chaining || tween.playing) {
      setChaining(false);
      tween.pause();
      return;
    }
    setChaining(true);
    tween.play(() => {
      const next = optimize === null ? null : firstChangedFrom(optimize.steps, stepRef.current + 1);
      if (next === null) setChaining(false);
      else setStepIndex(next);
    });
  }, [chaining, optimize, tween]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void runQuery();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); goNext(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); goPrevious(); }
      else if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'r' || event.key === 'R') { event.preventDefault(); tween.play(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrevious, runQuery, togglePlay, tween]);

  const changedTotal = optimize?.steps.filter(candidate => candidate.changed).length ?? 0;
  const showsPlan = stage === 'plan' || stage === 'optimize';
  const stale = sql !== submission.sql || catalogVersion !== submission.version;

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}${compact ? ' compact' : ''}`} data-pane={pane}>
      <TopBar
        sql={sql}
        sidebarOpen={sidebarOpen}
        running={running}
        stale={stale}
        usesSampleSchema={usesSampleSchema}
        tableCount={tables.length}
        loadedRows={loadedRows}
        onSql={setSql}
        onToggleSidebar={() => setSidebarOpen(open => !open)}
        onRun={() => void runQuery()}
      />

      <div className="app-body">
        {compact || sidebarOpen ? (
          <aside className="panel panel-left">
            <div className="editor-shell">
              <SqlEditor value={sql} onChange={setSql} />
            </div>

            {outcome.ok ? null : (
              <p className="compile-error">
                <strong>{outcome.error.phase} error.</strong> {outcome.error.message}
              </p>
            )}

            <SchemaPanel
              tables={tables}
              usesSampleSchema={usesSampleSchema}
              rowCounts={rowCounts}
              statistics={statistics}
              importError={importError}
              importing={importing}
              onImport={files => void importFiles(files)}
              onDrop={table => { workspace.dropTable(table); setCatalogVersion(workspace.version); }}
              onRowCountChange={(table, rowCount) => { workspace.setRowCount(table, rowCount); setCatalogVersion(workspace.version); }}
              onResetRowCounts={() => { workspace.resetRowCounts(); setCatalogVersion(workspace.version); }}
            />
          </aside>
        ) : null}

        <section className="panel panel-middle">
          {trace && trace.subjects.length > 1 ? (
            <div className="subject-picker">
              {trace.subjects.map((candidate, index) => (
                <button
                  key={candidate.name}
                  type="button"
                  className={index === subjectIndex ? 'selected' : ''}
                  onClick={() => setSubjectIndex(index)}
                >
                  {candidate.name}
                </button>
              ))}
            </div>
          ) : null}

          {optimize ? (
            <>
              <PassList
                optimize={optimize}
                selectedStep={stepIndex}
                onSelect={selectStep}
                hideNoops={hideNoops}
                onHideNoopsChange={setHideNoops}
              />
              <PassNotes step={step} />
            </>
          ) : (
            <div className="stage-summary"><p>Fix the query to see the pipeline.</p></div>
          )}
        </section>

        <section className="panel panel-right">
          <div className="right-header">
            <StageRail
              selected={stage}
              badges={{
                plan: optimize ? { text: `${optimize.snapshots[0].nodes} nodes` } : undefined,
                optimize: optimize ? { text: `${changedTotal}/${optimize.steps.length}` } : undefined,
                results: result === null
                  ? undefined
                  : result.ok ? { text: formatCount(result.total) } : { text: 'error', tone: 'error' },
              }}
              onSelect={setStage}
            />
            {showsPlan ? (
              <div className="stage-phase view-phase">
                <span className="stage-caption">view</span>
                <div className="stage-group">
                  <button type="button" className={tab === 'tree' ? 'selected' : ''} onClick={() => setTab('tree')}>Tree</button>
                  <button type="button" className={tab === 'text' ? 'selected' : ''} onClick={() => setTab('text')}>Text</button>
                </div>
              </div>
            ) : null}
          </div>

          {stage === 'results' ? (
            <ResultsView outcome={result} running={running} onRun={() => void runQuery()} />
          ) : !trace ? (
            <div className="stage-summary"><p>No plan yet.</p></div>
          ) : stage === 'parse' ? (
            <JsonView title="Abstract syntax tree" subtitle="What the parser produced from the SQL text." value={trace.compiled.statement} />
          ) : stage === 'bind' ? (
            <JsonView title="Bound query" subtitle="Names resolved against the catalog, types inferred." value={trace.compiled.bound} />
          ) : stage === 'physical' ? (
            <PhysicalView physical={subject?.physical ?? null} />
          ) : (
            <>
              {tab === 'tree' ? (
                stage === 'plan' && planStageMorph ? (
                  <PlanGraph frame={planStageMorph} t={1} spotlight={false} legend={false} caption={null} onSelect={setSelected} />
                ) : morph ? (
                  <PlanGraph
                    frame={morph}
                    t={tween.t}
                    spotlight={spotlight}
                    legend
                    caption={step === null ? null : `${step.pass} · ${step.changed
                      ? `${optimize?.snapshots[step.from].nodes} → ${optimize?.snapshots[step.to].nodes} nodes`
                      : 'no change'}`}
                    onSelect={setSelected}
                  />
                ) : null
              ) : (
                optimize ? (
                  <PlanText
                    before={stage === 'optimize' && step ? optimize.snapshots[step.from].plan : null}
                    after={stage === 'optimize' && step ? optimize.snapshots[step.to].plan : optimize.snapshots[0].plan}
                  />
                ) : null
              )}

              {stage === 'optimize' && optimize ? (
                <Transport
                  t={tween.t}
                  playing={chaining || tween.playing}
                  speed={speed}
                  animated={!reducedMotion}
                  spotlight={spotlight}
                  hasPrevious={lastChangedBefore(optimize.steps, stepIndex) !== null || (!hideNoops && stepIndex > 0)}
                  hasNext={firstChangedFrom(optimize.steps, stepIndex + 1) !== null || (!hideNoops && stepIndex + 1 < optimize.steps.length)}
                  onScrub={tween.seek}
                  onReplay={() => tween.play()}
                  onPlayPause={togglePlay}
                  onPrevious={goPrevious}
                  onNext={goNext}
                  onSpeed={setSpeed}
                  onSpotlight={setSpotlight}
                />
              ) : null}

              {selected ? (
                <section className="node-inspector">
                  <h4>{selected.title}</h4>
                  {selected.detail ? <code>{selected.detail}</code> : null}
                  <p>
                    estimated rows {formatCount(selected.cardinality)}
                    <button type="button" onClick={() => setSelected(null)}>close</button>
                  </p>
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>

      {compact ? (
        <PaneRail
          selected={pane}
          badges={{
            passes: optimize ? `${changedTotal}/${optimize.steps.length}` : undefined,
            stages: STAGES.find(candidate => candidate.kind === stage)?.label,
          }}
          onSelect={setPane}
        />
      ) : null}
    </div>
  );
}
