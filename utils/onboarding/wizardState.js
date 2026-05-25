'use strict';

const Client = require('../../models/Client');
const { STEP_IDS } = require('../../constants/onboardingWizardSteps');

function defaultWizard(clientId) {
  return {
    clientId,
    wizardSchemaVersion: 4,
    currentStepId: 'business',
    currentStep: 0,
    completedSteps: [],
    status: 'in_progress',
    stepData: {},
    deploymentResult: null,
  };
}

async function findWizard(clientId) {
  const client = await Client.findOne({ clientId }).select('wizardState').lean();
  if (!client?.wizardState) return null;
  return { ...client.wizardState, clientId };
}

async function saveWizard(clientId, wizard) {
  const { clientId: _c, ...state } = wizard;
  await Client.updateOne(
    { clientId },
    { $set: { wizardState: state } },
    { upsert: false }
  );
  return wizard;
}

async function deleteWizard(clientId) {
  await Client.updateOne({ clientId }, { $unset: { wizardState: '' } });
}

function createMutableWizard(clientId, base = null) {
  const doc = base ? { ...base, clientId } : defaultWizard(clientId);
  let dirty = !base;
  return {
    get clientId() {
      return doc.clientId;
    },
    get wizardSchemaVersion() {
      return doc.wizardSchemaVersion;
    },
    set wizardSchemaVersion(v) {
      doc.wizardSchemaVersion = v;
      dirty = true;
    },
    get currentStepId() {
      return doc.currentStepId;
    },
    set currentStepId(v) {
      doc.currentStepId = v;
      dirty = true;
    },
    get currentStep() {
      return doc.currentStep;
    },
    set currentStep(v) {
      doc.currentStep = v;
      dirty = true;
    },
    get completedSteps() {
      return doc.completedSteps;
    },
    set completedSteps(v) {
      doc.completedSteps = v;
      dirty = true;
    },
    get status() {
      return doc.status;
    },
    set status(v) {
      doc.status = v;
      dirty = true;
    },
    get stepData() {
      return doc.stepData;
    },
    set stepData(v) {
      doc.stepData = v;
      dirty = true;
    },
    get deploymentResult() {
      return doc.deploymentResult;
    },
    set deploymentResult(v) {
      doc.deploymentResult = v;
      dirty = true;
    },
    toObject() {
      return { ...doc };
    },
    isModified() {
      return dirty;
    },
    markModified() {
      dirty = true;
    },
    async save() {
      await saveWizard(clientId, doc);
      dirty = false;
    },
  };
}

async function findOrCreateWizard(clientId) {
  const existing = await findWizard(clientId);
  return createMutableWizard(clientId, existing);
}

module.exports = {
  STEP_IDS,
  findWizard,
  findOrCreateWizard,
  saveWizard,
  deleteWizard,
  createMutableWizard,
  defaultWizard,
};
