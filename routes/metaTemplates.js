const express = require('express');
const { protect } = require('../middleware/auth');
const { submitTemplateToMeta } = require('../controllers/metaTemplates/templateSubmitController');
const {
  saveDraft,
  listTemplates,
  getOne,
  patchTemplate,
  deleteTemplate,
} = require('../controllers/metaTemplates/metaTemplatesApiController');

const router = express.Router();

router.post('/submit', protect, submitTemplateToMeta);
router.post('/draft', protect, saveDraft);
router.get('/', protect, listTemplates);
router.get('/:id', protect, getOne);
router.patch('/:id', protect, patchTemplate);
router.delete('/:id', protect, deleteTemplate);

module.exports = router;
