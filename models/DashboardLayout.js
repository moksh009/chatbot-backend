const mongoose = require('mongoose');

const WidgetSchema = new mongoose.Schema({
  id:          { type: String, required: true }, // "widget_abc123"
  type:        { type: String, required: true }, // see WIDGET_TYPES
  
  // Grid position (react-grid-layout format)
  x:           { type: Number, required: true }, // column position (0-11)
  y:           { type: Number, required: true }, // row position
  w:           { type: Number, required: true }, // width in columns
  h:           { type: Number, required: true }, // height in rows
  minW:        { type: Number, default: 1 },
  minH:        { type: Number, default: 1 },
  
  // Widget config
  title:       { type: String },                 // custom title override
  config:      { type: mongoose.Schema.Types.Mixed, default: {} }, // widget-specific settings
  refreshIntervalSec: { type: Number, default: 300 }  // 5 min
});

const DashboardLayoutSchema = new mongoose.Schema({
  clientId:     { type: String, required: true }, // Slug-based ID consistently used in auth
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // per-agent custom layout
  
  widgets:      [WidgetSchema],
  
  theme:        { type: String, default: "default" }, // "default" | "dark" | "compact"
  lastModifiedAt: { type: Date, default: Date.now },
  createdAt:    { type: Date, default: Date.now }
});

// Index for fast per-client/per-user lookup
DashboardLayoutSchema.index({ clientId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('DashboardLayout', DashboardLayoutSchema);
