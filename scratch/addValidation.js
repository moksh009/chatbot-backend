const fs = require('fs');
const file = '/Users/patelmoksh/LocalProjects/chatbot final/chatbot-backend-main/utils/aiFlowBuilder.js';
let content = fs.readFileSync(file, 'utf8');

const validationFunc = `
function verifyAllEdgesMatchButtonIds(nodes, edges) {
  // Ensure that every edge originating from an interactive node has a sourceHandle that matches an actual button ID
  const interactiveNodes = nodes.filter(n => n.type === 'interactive');
  
  let valid = true;
  let errorMsgs = [];

  for (const node of interactiveNodes) {
    const validIds = new Set();
    if (node.data?.interactiveType === 'button' && node.data.buttonsList) {
      node.data.buttonsList.forEach(b => validIds.add(String(b.id)));
    } else if (node.data?.interactiveType === 'list' && node.data.sections) {
      node.data.sections.forEach(s => {
        (s.rows || []).forEach(r => validIds.add(String(r.id)));
      });
    }

    const outgoingEdges = edges.filter(e => e.source === node.id);
    for (const edge of outgoingEdges) {
      if (!edge.sourceHandle || !validIds.has(String(edge.sourceHandle))) {
        valid = false;
        errorMsgs.push(\`Edge \${edge.id} from node \${node.id} has invalid sourceHandle "\${edge.sourceHandle}". Allowed IDs: \${Array.from(validIds).join(', ')}\`);
        
        // Auto-heal attempt: if only one valid ID exists, just map it
        if (validIds.size === 1) {
           edge.sourceHandle = Array.from(validIds)[0];
           valid = true;
           errorMsgs.pop();
        } else {
           // Otherwise just clear it so it doesn't break ReactFlow entirely
           edge.sourceHandle = null;
        }
      }
    }
  }
  
  if (!valid) {
    console.warn("[AI Flow Builder] Edge validation warnings:", errorMsgs);
  }
  return { nodes, edges, valid, errorMsgs };
}
`;

// Insert it right before validateAndCleanFlow
content = content.replace('function validateAndCleanFlow', validationFunc + '\nfunction validateAndCleanFlow');

// Call it at the end of validateAndCleanFlow
content = content.replace('return { nodes: validNodes, edges: validEdges };', 'return verifyAllEdgesMatchButtonIds(validNodes, validEdges);');

fs.writeFileSync(file, content);
console.log('Validation function added.');
