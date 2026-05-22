"use strict";

const mongoose = require("mongoose");

/**
 * OnboardingWizard — Persistent step-by-step wizard state.
 *
 * Step IDs — MUST match STEPS in dashboard wizard/constants.js (8 steps, schema v4):
 *   0: business | 1: connections | 2: features | 3: products | 4: escalation
 *   5: templates | 6: ai | 7: architecture
 *
 * `cart_timing` remains as optional legacy bucket; cart ladder lives in features step UI.
 */

const STEP_IDS = [
  "business",
  "connections",
  "features",
  "products",
  "escalation",
  "templates",
  "ai",
  "architecture",
];

const OnboardingWizardSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    wizardSchemaVersion: {
      type: Number,
      default: 4,
      min: 1,
      max: 10,
    },

    /** Canonical step id — preferred over numeric currentStep for UI sync */
    currentStepId: {
      type: String,
      default: "business",
      enum: STEP_IDS,
    },

    currentStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 7,
    },

    completedSteps: {
      type: [Number],
      default: [],
    },

    status: {
      type: String,
      enum: ["in_progress", "completed", "abandoned"],
      default: "in_progress",
    },

    stepData: {
      business:     { type: mongoose.Schema.Types.Mixed, default: null },
      connections:  { type: mongoose.Schema.Types.Mixed, default: null },
      features:     { type: mongoose.Schema.Types.Mixed, default: null },
      products:     { type: mongoose.Schema.Types.Mixed, default: null },
      escalation:   { type: mongoose.Schema.Types.Mixed, default: null },
      ai:           { type: mongoose.Schema.Types.Mixed, default: null },
      architecture: { type: mongoose.Schema.Types.Mixed, default: null },
      cart_timing:  { type: mongoose.Schema.Types.Mixed, default: null },
      whatsapp:     { type: mongoose.Schema.Types.Mixed, default: null },
      store:        { type: mongoose.Schema.Types.Mixed, default: null },
      operations:   { type: mongoose.Schema.Types.Mixed, default: null },
      payment:      { type: mongoose.Schema.Types.Mixed, default: null },
      meta_ads:     { type: mongoose.Schema.Types.Mixed, default: null },
      instagram:    { type: mongoose.Schema.Types.Mixed, default: null },
      templates:    { type: mongoose.Schema.Types.Mixed, default: null },
    },

    deploymentResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

OnboardingWizardSchema.statics.STEP_IDS = STEP_IDS;

module.exports = mongoose.model("OnboardingWizard", OnboardingWizardSchema);
