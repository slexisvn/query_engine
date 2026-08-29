import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffPlans } from './engine/plan-diff.js';
import { buildMorph, contentAt } from './engine/morph.js';
import { toPlanView } from './engine/plan-view.js';
import { sizePlanNode } from './ui/node-sizer.js';
import { traceQuery } from './engine/trace.js';
import { summarizeDiff } from './engine/step-summary.js';
import { joinOrderNote } from './engine/join-order-note.js';
import { indexKey } from './engine/column-facts.js';
import { indexScannedTables } from './engine/estimate-provenance.js';
import { Workspace } from './engine/workspace.js';
import { DEFAULT_EXAMPLE } from './content/examples.js';
import { CompileError } from './ui/CompileError.js';
import { JsonView } from './ui/JsonView.js';
import { NodeInspector } from './ui/NodeInspector.js';
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
import { ShareMenu } from './ui/ShareMenu.js';
import { TopBar } from './ui/TopBar.js';
import { Transport } from './ui/Transport.js';
import { useMediaQuery } from './ui/useMediaQuery.js';
import { useReducedMotion, useTween } from './ui/useTween.js';
import { formatCount } from './ui/format.js';
import { flattenProfile, qErrorOf } from '@engine/execution/execution-profile.js';
import { toneOf } from './engine/profile-view.js';
import { readSession, readSharedState, shareLinkFor, writeSession } from './session-state.js';
import { buildRepro, serializeRepro } from './engine/repro.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { OptimizeTrace, PassStep } from './engine/trace.js';
import type { PaneKind } from './ui/PaneRail.js';
import type { UnmeasuredReason } from './ui/PhysicalView.js';
import type { RunOutcome } from './engine/workspace.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { StageKind } from './ui/StageRail.js';

const MORPH_DURATION_MS = 700;
const COMPACT_LAYOUT = '(max-width: 1000px)';
const TYPING_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;
const ACTIVATES_ON_SPACE = /^(BUTTON|A|SUMMARY)$/;
const FAILED_BADGE = { text: 'error', tone: 'error' } as const;

type PlanTab = 'tree' | 'text';

interface Submission {
  sql: string;
  statistics: Map<string, TableStats>;
  version: number;
  disabled: ReadonlySet<string>;
}

interface PinnedPlan {
  plan: LogicalPlanNode;
  label: string;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
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

function bootstrap(): { workspace: Workspace; sql: string; disabled: ReadonlySet<string> } {
  const workspace = new Workspace();
  const shared = readSharedState();
  const saved = shared ?? readSession();
  if (saved) {
    for (const [table, rowCount] of Object.entries(saved.rowCounts)) workspace.setRowCount(table, rowCount);
  }
  return {
    workspace,
    sql: saved?.sql ?? DEFAULT_EXAMPLE.sql,
    disabled: new Set(shared?.disabled ?? []),
  };
}

export function App() {
  const start = useMemo(bootstrap, []);
  const workspace = start.workspace;

  const [sql, setSql] = useState(start.sql);
  const [submission, setSubmission] = useState<Submission>(
    () => ({
      sql: start.sql,
      statistics: start.workspace.statistics(),
      version: start.workspace.version,
      disabled: start.disabled,
    }),
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pinned, setPinned] = useState<PinnedPlan | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [result, setResult] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [disabledPasses, setDisabledPasses] = useState<ReadonlySet<string>>(start.disabled);

  const compact = useMediaQuery(COMPACT_LAYOUT);

  useEffect(() => {
    let live = true;
    void workspace.ready.then(() => {
      if (!live) return;
      setCatalogVersion(workspace.version);
      setSubmission(current => ({ ...current, version: workspace.version }));
    });
    return () => { live = false; };
  }, [workspace]);

  const statistics = useMemo(() => workspace.statistics(), [workspace, catalogVersion]);
  const tables = useMemo(() => workspace.tables(), [workspace, catalogVersion]);
  const rowCounts = useMemo(() => workspace.sampleRowCounts(), [workspace, catalogVersion]);
  const usesSampleSchema = useMemo(() => workspace.usesSampleSchema, [workspace, catalogVersion]);
  const loadedRows = useMemo(
    () => tables.reduce((total, table) => total + table.dataRows, 0),
    [tables],
  );
  const tableNames = useMemo(() => tables.map(table => table.name), [tables]);
  const indexedColumns = useMemo(
    () => new Set(tables.flatMap(table => table.indexed.map(column => indexKey(table.name, column)))),
    [tables],
  );
  const columnTypes = useMemo(
    () => new Map(tables.flatMap(table => table.columns.map(
      column => [indexKey(table.name, column.name), String(column.dataType)] as const,
    ))),
    [tables],
  );

  const baseline = useMemo(
    () => traceQuery(submission.sql, workspace.catalog, submission.statistics),
    [submission, workspace],
  );

  const ablated = useMemo(
    () => (disabledPasses.size === 0
      ? null
      : traceQuery(submission.sql, workspace.catalog, submission.statistics, disabledPasses)),
    [disabledPasses, submission, workspace],
  );

  const outcome = ablated ?? baseline;

  const togglePass = useCallback((pass: string) => {
    setDisabledPasses(current => {
      const next = new Set(current);
      if (!next.delete(pass)) next.add(pass);
      return next;
    });
  }, []);

  useEffect(() => writeSession({ sql, rowCounts }), [sql, rowCounts]);

  const trace = outcome.ok ? outcome.trace : null;
  const subject = trace?.subjects[Math.min(subjectIndex, trace.subjects.length - 1)] ?? null;
  const optimize: OptimizeTrace | null = subject?.optimize ?? null;

  useEffect(() => {
    if (!optimize) return;
    setSubjectIndex(current => (trace && current < trace.subjects.length ? current : 0));
    setStepIndex(firstChangedFrom(optimize.steps, 0) ?? 0);
    setSelectedKey(null);
    setPinned(null);
  }, [optimize, trace]);

  const reducedMotion = useReducedMotion();
  const tween = useTween(MORPH_DURATION_MS / speed, !reducedMotion);
  const step = optimize?.steps[stepIndex] ?? null;

  const morphed = useMemo(() => {
    if (!optimize) return null;
    const beforePlan = pinned
      ? pinned.plan
      : step ? optimize.snapshots[step.from].display : optimize.snapshots[0].display;
    const afterPlan = step ? optimize.snapshots[step.to].display : optimize.snapshots[0].display;
    const before = toPlanView(beforePlan);
    const after = toPlanView(afterPlan);
    const diff = diffPlans(before, after);
    return {
      frame: buildMorph(before, after, diff, sizePlanNode),
      summary: summarizeDiff(before, after, diff),
      beforePlan,
      afterPlan,
    };
  }, [optimize, pinned, step]);

  const morph = morphed?.frame ?? null;

  const planStageMorph = useMemo(() => {
    if (!optimize) return null;
    const plan = optimize.snapshots[0].display;
    const view = toPlanView(plan);
    return {
      frame: buildMorph(view, view, diffPlans(view, view), sizePlanNode),
      beforePlan: plan,
      afterPlan: plan,
    };
  }, [optimize]);

  const chainRef = useRef(false);
  const stepRef = useRef(stepIndex);
  const playRef = useRef(tween.play);
  const sqlRef = useRef(sql);
  const disabledRef = useRef(disabledPasses);
  const busyRef = useRef(false);
  stepRef.current = stepIndex;
  playRef.current = tween.play;
  chainRef.current = chaining;
  sqlRef.current = sql;
  disabledRef.current = disabledPasses;

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
    const disabled = disabledRef.current;
    busyRef.current = true;
    setSubmission({ sql: pending, statistics: workspace.statistics(), version: workspace.version, disabled });
    setPane(current => (current === 'query' ? 'stages' : current));
    setRunning(true);
    const ran = await workspace.run(pending, disabled);
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
      if (target && (target.isContentEditable || TYPING_TAGS.test(target.tagName))) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); goNext(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); goPrevious(); }
      else if (event.key === ' ' && !(target && ACTIVATES_ON_SPACE.test(target.tagName))) { event.preventDefault(); togglePlay(); }
      else if (event.key === 'r' || event.key === 'R') { event.preventDefault(); tween.play(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrevious, runQuery, togglePlay, tween]);

  const changedTotal = optimize?.steps.filter(candidate => candidate.changed).length ?? 0;
  const showsPlan = stage === 'plan' || stage === 'optimize';
  const stale = sql !== submission.sql
    || catalogVersion !== submission.version
    || !sameSet(disabledPasses, submission.disabled);
  const failedPhase = outcome.ok ? null : outcome.error.phase;
  const estimatedRows = optimize === null
    ? null
    : optimize.snapshots[optimize.snapshots.length - 1].display._cardinality ?? null;
  const measuresMainQuery = subjectIndex === 0;
  const ran = result !== null && result.ok && !stale;
  const profile = ran && measuresMainQuery ? result.profile : null;
  const unmeasured: UnmeasuredReason | null = profile !== null ? null : ran ? 'other-subject' : 'not-run';
  const reproProfile = ran ? result.profile : null;

  const reproState = useMemo(
    () => ({ sql, rowCounts, disabled: [...disabledPasses] }),
    [disabledPasses, rowCounts, sql],
  );

  const togglePin = useCallback(() => {
    setPinned(current => {
      if (current !== null || !optimize) return null;
      const at = step ? step.to : 0;
      return { plan: optimize.snapshots[at].display, label: step ? `${step.pass} (step ${step.index + 1})` : 'the unoptimized plan' };
    });
  }, [optimize, step]);

  const pinBaseline = useCallback(() => {
    if (!baseline.ok) return;
    const subject = baseline.trace.subjects[Math.min(subjectIndex, baseline.trace.subjects.length - 1)];
    const snapshots = subject.optimize.snapshots;
    setPinned({ plan: snapshots[snapshots.length - 1].display, label: 'the full pipeline' });
  }, [baseline, subjectIndex]);

  const copyLink = useCallback(() => shareLinkFor(reproState), [reproState]);

  const copyRepro = useCallback(
    () => serializeRepro(buildRepro({
      sql,
      rowCounts,
      disabled: disabledPasses,
      tables,
      statistics,
      profile: reproProfile,
    })),
    [disabledPasses, reproProfile, rowCounts, sql, statistics, tables],
  );
  const baselineCost = ablated === null || !baseline.ok
    ? null
    : baseline.trace.subjects[Math.min(subjectIndex, baseline.trace.subjects.length - 1)]?.optimize.snapshots.at(-1)?.cost ?? null;
  const indexScanned = useMemo(
    () => (optimize === null ? new Set<string>() : indexScannedTables(optimize.snapshots.at(-1)!.display)),
    [optimize],
  );

  const canvas = stage === 'plan' ? planStageMorph : morphed;
  const canvasT = stage === 'plan' ? 1 : tween.t;
  const selection = canvas === null || selectedKey === null
    ? null
    : contentAt(canvas.frame, selectedKey, canvasT);

  const worstQError = useMemo(() => {
    if (profile === null) return null;
    const entries = flattenProfile(profile.roots).filter(entry => entry.invocations > 0);
    return entries.length === 0 ? null : Math.max(...entries.map(qErrorOf));
  }, [profile]);

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}${compact ? ' compact' : ''}`} data-pane={pane}>
      <TopBar
        sql={sql}
        sidebarOpen={sidebarOpen}
        running={running}
        stale={stale}
        neverRun={result === null}
        usesSampleSchema={usesSampleSchema}
        tableCount={tables.length}
        loadedRows={loadedRows}
        onSql={setSql}
        onToggleSidebar={() => setSidebarOpen(open => !open)}
        onRun={() => void runQuery()}
      >
        <ShareMenu onLink={copyLink} onRepro={copyRepro} />
      </TopBar>

      <div className="app-body">
        {compact || sidebarOpen ? (
          <aside className="panel panel-left">
            <div className="editor-shell">
              <SqlEditor value={sql} onChange={setSql} />
            </div>

            {outcome.ok ? null : (
              <CompileError error={outcome.error} sql={submission.sql} tables={tableNames} stale={stale} />
            )}

            <SchemaPanel
              tables={tables}
              usesSampleSchema={usesSampleSchema}
              dataRows={loadedRows}
              rowCounts={rowCounts}
              statistics={statistics}
              importError={importError}
              importing={importing}
              onImport={files => void importFiles(files)}
              onDrop={table => void workspace.dropTable(table).then(() => setCatalogVersion(workspace.version))}
              onRowCountChange={(table, rowCount) => { workspace.setRowCount(table, rowCount); setCatalogVersion(workspace.version); }}
              onResetRowCounts={() => { workspace.resetRowCounts(); setCatalogVersion(workspace.version); }}
            />
          </aside>
        ) : null}

        <section className="panel panel-middle">
          {trace && trace.subjects.length > 1 ? (
            <div className="subject-picker">
              <span className="stage-caption">plan for</span>
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
                disabled={disabledPasses}
                onToggleDisabled={togglePass}
                baselineCost={baselineCost}
                onCompareBaseline={ablated === null ? null : pinBaseline}
              />
              <PassNotes
                step={step}
                summary={morphed?.summary ?? null}
                joinOrder={step?.pass === 'JoinReorder' ? joinOrderNote(optimize.snapshots[step.from].plan) : null}
              />
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
                parse: failedPhase === 'parse' ? FAILED_BADGE : undefined,
                bind: failedPhase === 'bind' ? FAILED_BADGE : undefined,
                plan: failedPhase === 'plan'
                  ? FAILED_BADGE
                  : optimize ? { text: `${optimize.snapshots[0].nodes} nodes` } : undefined,
                optimize: optimize ? { text: `${changedTotal}/${optimize.steps.length}` } : undefined,
                physical: worstQError === null
                  ? undefined
                  : { text: `${worstQError.toFixed(1)}× off`, tone: toneOf(worstQError) === 'bad' ? 'error' : undefined },
                results: !outcome.ok || result === null
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
            <ResultsView outcome={result} estimated={estimatedRows} running={running} onRun={() => void runQuery()} />
          ) : !trace ? (
            <div className="stage-summary">
              {outcome.ok
                ? <p>No plan yet.</p>
                : <CompileError error={outcome.error} sql={submission.sql} tables={tableNames} stale={stale} />}
            </div>
          ) : stage === 'parse' ? (
            <JsonView title="Abstract syntax tree" subtitle="What the parser produced from the SQL text." value={trace.compiled.statement} />
          ) : stage === 'bind' ? (
            <JsonView title="Bound query" subtitle="Names resolved against the catalog, types inferred." value={trace.compiled.bound} />
          ) : stage === 'physical' ? (
            <PhysicalView
              physical={subject?.physical ?? null}
              planner={trace?.metrics.planner ?? null}
              profile={profile}
              unmeasured={unmeasured}
            />
          ) : (
            <>
              {tab === 'tree' ? (
                stage === 'plan' && planStageMorph ? (
                  <PlanGraph
                    frame={planStageMorph.frame}
                    t={1}
                    spotlight={false}
                    legend={false}
                    fitWhole={compact}
                    caption={null}
                    onSelect={setSelectedKey}
                  />
                ) : morph ? (
                  <PlanGraph
                    frame={morph}
                    t={tween.t}
                    spotlight={spotlight}
                    legend={!compact}
                    fitWhole={compact}
                    caption={pinned
                      ? `${pinned.label} → ${step === null ? 'the unoptimized plan' : step.pass}`
                      : step === null ? null : `${step.pass} · ${step.changed
                        ? `${optimize?.snapshots[step.from].nodes} → ${optimize?.snapshots[step.to].nodes} nodes`
                        : 'no change'}`}
                    onSelect={setSelectedKey}
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
                  scrubbable={tab === 'tree'}
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
                  pinnedLabel={pinned?.label ?? null}
                  onTogglePin={togglePin}
                />
              ) : null}

              {selection && canvas ? (
                <NodeInspector
                  node={selection.node}
                  root={selection.side === 'after' ? canvas.afterPlan : canvas.beforePlan}
                  statistics={submission.statistics}
                  indexed={indexedColumns}
                  indexScanned={indexScanned}
                  columnTypes={columnTypes}
                  onClose={() => setSelectedKey(null)}
                />
              ) : null}
            </>
          )}
        </section>
      </div>

      {compact ? (
        <PaneRail
          selected={pane}
          badges={{
            query: stale ? 'run it' : undefined,
            passes: optimize ? `${changedTotal}/${optimize.steps.length}` : undefined,
            stages: STAGES.find(candidate => candidate.kind === stage)?.label,
          }}
          onSelect={setPane}
        />
      ) : null}
    </div>
  );
}
