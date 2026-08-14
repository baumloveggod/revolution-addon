/**
 * Wallet/Scoring globals.
 *
 * Replaces the former Rollup output `wallet/wallet-bundle.js`. Instead of a
 * machine-generated bundle, the addon ships the unmodified sources from
 * `packages/revolution-wallet/src/` in `vendor/revolution-client/` and loads
 * them here as a plain ES module.
 *
 * Loaded first in background.html, so window.* is populated before the classic
 * background scripts run (module scripts and deferred classic scripts execute
 * in document order).
 */

// --- Wallet ---
import { WalletManager } from './wallet-manager.js';
import { AnonTransactionClient } from './anon-transaction-client.js';
import { FingerprintSeedManager } from './fingerprint-seed-manager.js';

// --- Scoring ---
import CONFIG from './scoring-config.js';
import { ContentDetector } from './content-detector.js';
import { InteractionScorer } from './interaction-scorer.js';
import { QualityAnalyzer } from './quality-analyzer.js';
import { SatisfactionScorer } from './satisfaction-scorer.js';
import { ScoringEngine, createScoringEngine } from './scoring-engine.js';

// --- Services ---
import { EntityResolver } from './entity-resolver.js';
import { FeedbackManager } from './feedback-manager.js';
import { TransactionCorrector } from './transaction-corrector.js';
import { RetroPayoutService } from './retro-payout-service.js';

// --- Distribution ---
import { TranslationFactorTracker } from './translation-factor-tracker.js';
import { DistributionEngine } from './distribution-engine.js';
import { CalibrationManager } from './calibration-manager.js';
import { PrognosisModel } from './prognosis-model.js';

// --- Safety Factors ---
import { DampingSafetyFactor } from './damping-safety-factor.js';
import { StartSafetyFactor } from './start-safety-factor.js';
import { PrognosisSafetyFactor } from './prognosis-safety-factor.js';
import { FluctuationSafetyFactor } from './fluctuation-safety-factor.js';

// Wallet
window.WalletManager = WalletManager;
window.AnonTransactionClient = AnonTransactionClient;
window.FingerprintSeedManager = FingerprintSeedManager;

// Scoring
window.ScoringConfig = CONFIG;
window.ContentDetector = ContentDetector;
window.InteractionScorer = InteractionScorer;
window.QualityAnalyzer = QualityAnalyzer;
window.SatisfactionScorer = SatisfactionScorer;
window.ScoringEngine = ScoringEngine;
window.createScoringEngine = createScoringEngine;

// Services
window.EntityResolver = EntityResolver;
window.FeedbackManager = FeedbackManager;
window.TransactionCorrector = TransactionCorrector;
window.RetroPayoutService = RetroPayoutService;

// Distribution
window.TranslationFactorTracker = TranslationFactorTracker;
window.DistributionEngine = DistributionEngine;
window.CalibrationManager = CalibrationManager;
window.PrognosisModel = PrognosisModel;

// Safety Factors
window.DampingSafetyFactor = DampingSafetyFactor;
window.StartSafetyFactor = StartSafetyFactor;
window.PrognosisSafetyFactor = PrognosisSafetyFactor;
window.FluctuationSafetyFactor = FluctuationSafetyFactor;

window.dispatchEvent(new Event('revolution-wallet-ready'));
