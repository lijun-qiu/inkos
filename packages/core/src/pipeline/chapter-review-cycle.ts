import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideSoftRange } from "../utils/length-metrics.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 2;
/** Hard cap for auto-repair: prefer few spot-fix passes over long rewrite loops. */
const AUTO_REPAIR_MAX_ITERATIONS = 2;
const PASS_SCORE_THRESHOLD = 88;
const NET_IMPROVEMENT_EPSILON = 3;
/** Stop burning revise calls when the best score plateaus this many times in a row. */
const MAX_STALL_ROUNDS = 2;

interface ReviewSnapshot {
  readonly content: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly score: number;
  readonly lengthInRange: boolean;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode?: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        chapterIntentData?: ChapterIntent;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly normalizePostWriteSurface?: (chapterContent: string) => string;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  /** Re-run deterministic post-write checks (chapter-ref, paragraph shape, etc.) on any content. */
  readonly runPostWriteChecks?: (content: string) => ReadonlyArray<AuditIssue>;
  readonly maxReviewIterations?: number;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;

  // Convert initial postWriteErrors into AuditIssues as fallback when runPostWriteChecks isn't provided.
  const initialPostWriteIssues: ReadonlyArray<AuditIssue> = params.initialOutput.postWriteErrors.map((violation) => ({
    severity: "critical" as const,
    category: violation.rule,
    description: violation.description,
    suggestion: violation.suggestion,
  }));

  // ---------------------------------------------------------------------------
  // Length normalization: soft-range drift (hard was too loose — e.g. 3677 with
  // softMax 3409 never compressed). Normalize also re-runs after each revise.
  // ---------------------------------------------------------------------------
  const normalizeIfSoftDrift = async (content: string): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
  }> => {
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    if (!isOutsideSoftRange(wordCount, params.lengthSpec)) {
      return { content, wordCount, applied: false };
    }
    const result = await params.normalizeDraftLengthIfNeeded(content);
    totalUsage = params.addUsage(totalUsage, result.tokenUsage);
    return result;
  };

  const normalizedBeforeAudit = await normalizeIfSoftDrift(finalContent);
  finalContent = params.normalizePostWriteSurface?.(normalizedBeforeAudit.content) ?? normalizedBeforeAudit.content;
  finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  // ---------------------------------------------------------------------------
  // Helper: assess a chapter (audit + deterministic checks + length + score)
  // ---------------------------------------------------------------------------
  const assess = async (
    content: string,
    options?: { temperature?: number },
  ): Promise<{ auditResult: AuditResult; score: number; lengthInRange: boolean }> => {
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      params.reducedControlInput
        ? { ...params.reducedControlInput, ...(options ?? {}) }
        : options,
    );
    totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
    const aiTellsResult = params.analyzeAITells(content);
    const sensitiveResult = params.analyzeSensitiveWords(content);
    const hasBlockedWords = sensitiveResult.found.some((item) => item.severity === "block");
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    const lengthInRange = !isOutsideSoftRange(wordCount, params.lengthSpec);

    // Deterministic post-write checks: run every round, not just the first.
    // If runPostWriteChecks is provided, use it; otherwise fall back to initial postWriteErrors.
    const postWriteIssues = params.runPostWriteChecks
      ? params.runPostWriteChecks(content)
      : initialPostWriteIssues;

    const lengthIssues: AuditIssue[] = lengthInRange ? [] : [{
      severity: "warning",
      category: "length",
      description: params.lengthSpec.countingMode === "en_words"
        ? `Chapter length ${wordCount} is outside soft range ${params.lengthSpec.softMin}-${params.lengthSpec.softMax} (target ${params.lengthSpec.target})`
        : `章节字数 ${wordCount} 超出软区间 ${params.lengthSpec.softMin}-${params.lengthSpec.softMax}（目标 ${params.lengthSpec.target}）`,
      suggestion: wordCount > params.lengthSpec.softMax
        ? (params.lengthSpec.countingMode === "en_words"
          ? `Compress toward ~${params.lengthSpec.target} words; cut filler dialogue/repeated interiority; keep plot and hooks`
          : `压缩到约 ${params.lengthSpec.target} 字，删注水对话/重复心理，保留情节与钩子`)
        : (params.lengthSpec.countingMode === "en_words"
          ? `Expand toward ~${params.lengthSpec.target} words with concrete scenes/action, not empty lyricism`
          : `扩写到约 ${params.lengthSpec.target} 字，补足场面与动作，不要空抒情`),
      repairScope: "local",
    }];

    const allIssues: AuditIssue[] = [
      ...llmAudit.issues,
      ...aiTellsResult.issues,
      ...sensitiveResult.issues,
      ...postWriteIssues,
      ...lengthIssues,
    ];

    const hasPostWriteCritical = postWriteIssues.some((i) => i.severity === "critical");
    const auditResult: AuditResult = {
      passed: (hasBlockedWords || hasPostWriteCritical) ? false : llmAudit.passed,
      issues: allIssues,
      summary: llmAudit.summary,
      parseFailed: llmAudit.parseFailed,
      overallScore: llmAudit.overallScore,
    };

    const score = llmAudit.overallScore ?? 0;

    return { auditResult, score, lengthInRange };
  };

  // Old gate: LLM/post-write must mark passed, score >= threshold, soft length OK.
  const isPassed = (assessment: { auditResult: AuditResult; score: number; lengthInRange: boolean }): boolean =>
    assessment.auditResult.passed
    && assessment.score >= PASS_SCORE_THRESHOLD
    && assessment.lengthInRange;

  const snapshotMeetsPassGate = (
    snap: Pick<ReviewSnapshot, "auditResult" | "score" | "lengthInRange">,
  ): boolean =>
    snap.auditResult.passed
    && snap.score >= PASS_SCORE_THRESHOLD
    && snap.lengthInRange;

  // ---------------------------------------------------------------------------
  // Scoring loop: assess → revise → normalize → assess until pass or cap.
  // ---------------------------------------------------------------------------
  const maxReviewIterations = Math.min(
    AUTO_REPAIR_MAX_ITERATIONS,
    Math.max(0, Math.floor(params.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS)),
  );
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = await assess(finalContent);

  const snapshots: ReviewSnapshot[] = [{
    content: finalContent,
    wordCount: finalWordCount,
    auditResult: initial.auditResult,
    score: initial.score,
    lengthInRange: initial.lengthInRange,
  }];

  let currentAudit = initial;
  let postReviseCount = 0;
  let stallRounds = 0;

  if (initial.auditResult.parseFailed) {
    params.logWarn({
      zh: "审稿输出解析失败，跳过自动修稿以避免误改正文",
      en: "Audit output parsing failed; skipping automatic repair to avoid rewriting valid prose from an unreliable audit.",
    });
    return {
      finalContent,
      finalWordCount,
      preAuditNormalizedWordCount: finalWordCount,
      revised: false,
      auditResult: initial.auditResult,
      totalUsage,
      postReviseCount,
      normalizeApplied,
    };
  }

  if (!isPassed(initial)) {
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      params.logStage({
        zh: `定点精修 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分，目标 ≥${PASS_SCORE_THRESHOLD}）`,
        en: `spot-fix iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score}, pass ≥${PASS_SCORE_THRESHOLD})`,
      });

      // Only touch critical/hard faults. Soft length drift is handled by normalize,
      // not whole-chapter rewrite (which tends to inflate word count).
      const hardIssues = currentAudit.auditResult.issues.filter((issue) => issue.severity === "critical");
      if (hardIssues.length === 0) {
        params.logWarn({
          zh: `无 critical 硬伤，跳过定点精修（字数问题交给归一化）`,
          en: `no critical issues left; skipping spot-fix (length handled by normalizer)`,
        });
        const lengthOnlyFix = await normalizeIfSoftDrift(finalContent);
        finalContent = params.normalizePostWriteSurface?.(lengthOnlyFix.content) ?? lengthOnlyFix.content;
        finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
        normalizeApplied = normalizeApplied || lengthOnlyFix.applied;
        break;
      }

      const reviser = params.createReviser();
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        hardIssues,
        "spot-fix",
        params.book.genre,
        { ...params.reducedControlInput, lengthSpec: params.lengthSpec },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length === 0 || reviseOutput.revisedContent === finalContent) {
        params.logWarn({
          zh: `定点精修 ${iteration + 1} 未产出新内容，退出循环`,
          en: `spot-fix iteration ${iteration + 1} produced no new content, exiting loop`,
        });
        break;
      }

      params.assertChapterContentNotEmpty(reviseOutput.revisedContent, `spot-fix iteration ${iteration + 1}`);
      let revisedContent = params.normalizePostWriteSurface?.(reviseOutput.revisedContent) ?? reviseOutput.revisedContent;
      const lengthFix = await normalizeIfSoftDrift(revisedContent);
      revisedContent = params.normalizePostWriteSurface?.(lengthFix.content) ?? lengthFix.content;
      normalizeApplied = normalizeApplied || lengthFix.applied;
      const revisedWordCount = countChapterLength(revisedContent, params.lengthSpec.countingMode);

      const nextAssessment = await assess(revisedContent, { temperature: 0 });

      snapshots.push({
        content: revisedContent,
        wordCount: revisedWordCount,
        auditResult: nextAssessment.auditResult,
        score: nextAssessment.score,
        lengthInRange: nextAssessment.lengthInRange,
      });

      if (isPassed(nextAssessment)) {
        params.logStage({
          zh: `定点精修后达到通过线（${nextAssessment.score} 分），退出循环`,
          en: `spot-fix reached pass threshold (${nextAssessment.score}), exiting loop`,
        });
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        break;
      }

      if (nextAssessment.score >= PASS_SCORE_THRESHOLD && !isPassed(nextAssessment)) {
        params.logWarn({
          zh: !nextAssessment.auditResult.passed
            ? `分数已达 ${nextAssessment.score}，但审稿仍未通过（还有 critical/硬伤），继续定点精修`
            : `分数已达 ${nextAssessment.score}，但字数不在软区间，继续处理`,
          en: !nextAssessment.auditResult.passed
            ? `score ${nextAssessment.score} meets threshold but audit not passed; continuing spot-fix`
            : `score ${nextAssessment.score} meets threshold but length is outside soft range; continuing`,
        });
      }

      if (nextAssessment.score >= currentAudit.score + NET_IMPROVEMENT_EPSILON) {
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        stallRounds = 0;
      } else if (nextAssessment.score >= currentAudit.score) {
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        stallRounds += 1;
      } else {
        params.logWarn({
          zh: `定点精修 ${iteration + 1} 分数未提升（${currentAudit.score} → ${nextAssessment.score}），保留当前最佳并继续`,
          en: `spot-fix iteration ${iteration + 1} score did not rise (${currentAudit.score} → ${nextAssessment.score}); keeping best and continuing`,
        });
        stallRounds += 1;
      }

      if (stallRounds >= MAX_STALL_ROUNDS) {
        params.logWarn({
          zh: `连续 ${stallRounds} 轮分数停滞，停止定点精修（当前最佳 ${currentAudit.score} 分）`,
          en: `score stalled for ${stallRounds} rounds; stopping spot-fix (best ${currentAudit.score})`,
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pick the best snapshot: never discard a pass-gate winner for a higher score
  // that still fails the gate (that bug rolled 88-pass back to 92-fail).
  // ---------------------------------------------------------------------------
  const bestSnapshot = snapshots.reduce((best, snap) => {
    const snapOk = snapshotMeetsPassGate(snap);
    const bestOk = snapshotMeetsPassGate(best);
    if (snapOk !== bestOk) {
      return snapOk ? snap : best;
    }
    if (snap.lengthInRange !== best.lengthInRange) {
      return snap.lengthInRange ? snap : best;
    }
    return snap.score >= best.score + NET_IMPROVEMENT_EPSILON ? snap : best;
  });

  const currentMeetsPassGate = isPassed(currentAudit);
  const bestMeetsPassGate = snapshotMeetsPassGate(bestSnapshot);
  const shouldRestoreBestSnapshot = bestSnapshot.content !== finalContent && (
    (bestMeetsPassGate && !currentMeetsPassGate)
    || (bestMeetsPassGate === currentMeetsPassGate && bestSnapshot.lengthInRange && !currentAudit.lengthInRange)
    || (bestMeetsPassGate === currentMeetsPassGate
      && bestSnapshot.lengthInRange === currentAudit.lengthInRange
      && bestSnapshot.score >= currentAudit.score + NET_IMPROVEMENT_EPSILON)
  );
  if (shouldRestoreBestSnapshot) {
    params.logWarn({
      zh: `回退到最高分版本（${bestSnapshot.score} 分 vs 当前 ${currentAudit.score} 分）`,
      en: `rolling back to highest-scoring version (${bestSnapshot.score} vs current ${currentAudit.score})`,
    });
    finalContent = bestSnapshot.content;
    finalWordCount = bestSnapshot.wordCount;
    currentAudit = {
      auditResult: bestSnapshot.auditResult,
      score: bestSnapshot.score,
      lengthInRange: bestSnapshot.lengthInRange,
    };
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount: finalWordCount,
    revised: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    auditResult: currentAudit.auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
  };
}
