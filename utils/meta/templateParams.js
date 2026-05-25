function resolveTemplateFieldValue({
  dataField,
  variableIndex,
  row = {},
  customTextValues = {},
  client = null,
}) {
  if (dataField === 'customText') {
    return (customTextValues && customTextValues[String(variableIndex)]) || '';
  }
  if (dataField === 'businessName') {
    return client?.businessName || client?.name || 'Our Store';
  }
  if (dataField === 'lastOrderDate') {
    if (!row?.lastPurchaseDate) return 'N/A';
    try {
      return new Date(row.lastPurchaseDate).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
    } catch (_) {
      return 'N/A';
    }
  }
  if (dataField === 'lastOrderValue') {
    const spent = Number(row?.totalSpent || 0);
    return `₹${Number.isFinite(spent) ? spent.toLocaleString('en-IN') : 0}`;
  }
  if (dataField === 'tags') {
    return Array.isArray(row?.tags) ? row.tags.join(', ') : '';
  }
  if (dataField === 'name') {
    return row?.name || row?.customerName || 'Customer';
  }
  return row?.[dataField] || row?.capturedData?.[dataField] || '';
}

function buildMappedBodyComponent({
  variableMapping = {},
  row = {},
  customTextValues = {},
  client = null,
}) {
  if (!variableMapping || Object.keys(variableMapping).length === 0) {
    return null;
  }
  const sortedKeys = Object.keys(variableMapping).sort((a, b) => Number(a) - Number(b));
  const parameters = sortedKeys.map((k) => {
    const value = resolveTemplateFieldValue({
      dataField: variableMapping[k],
      variableIndex: k,
      row,
      customTextValues,
      client,
    });
    return { type: 'text', text: String(value || '-').slice(0, 1000) };
  });
  if (!parameters.length) return null;
  return { type: 'body', parameters };
}

module.exports = {
  resolveTemplateFieldValue,
  buildMappedBodyComponent,
};
