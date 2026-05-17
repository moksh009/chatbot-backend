const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Client = require('../models/Client');

dotenv.config({ path: path.join(__dirname, '../.env') });

async function folderize() {
  try {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not defined in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const clientsToFix = ['delitech_smarthomes', 'choice_salon', 'choice_salon_holi'];
    
    for (const clientId of clientsToFix) {
      const client = await Client.findOne({ clientId });
      if (!client || !client.flowNodes || client.flowNodes.length === 0) {
          console.log(`Skipping ${clientId}: No nodes found.`);
          continue;
      }

      const hasFolders = client.flowNodes.some(n => n.type === 'folder');
      if (hasFolders) {
          console.log(`Client ${clientId} already has folders. Skipping.`);
          continue;
      }

      console.log(`Folderizing client: ${clientId}...`);
      
      const newNodes = [];
      const newEdges = (client.flowEdges || []).map(e => ({ ...e }));

      // Create main hierarchical containers
      const fSupport = { id: 'f_support', type: 'folder', position: { x: 600, y: 400 }, data: { label: 'Customer Support & FAQ' } };
      const fProducts = { id: 'f_products', type: 'folder', position: { x: 200, y: 400 }, data: { label: 'Products & Main Menu' } };
      
      newNodes.push(fProducts, fSupport);

      let productCount = 0;
      let supportCount = 0;

      client.flowNodes.forEach(node => {
        let updatedNode = { ...node };
        const label = (node.data?.label || '').toLowerCase();
        const text = (node.data?.text || node.data?.body || '').toLowerCase();

        // Keep triggers and high-level greetings at the root
        if (node.type === 'trigger' || label.includes('welcome') || node.id === 'welcome_node' || node.id === 'trigger_start') {
            updatedNode.parentId = null; // Root
        } else if (label.includes('support') || label.includes('faq') || text.includes('agent') || text.includes('help') || label.includes('handover')) {
            updatedNode.parentId = 'f_support';
            updatedNode.position = { x: 100, y: 100 + (supportCount * 150) };
            supportCount++;
        } else {
            // Everything else goes to Products/Main Group for now
            updatedNode.parentId = 'f_products';
            updatedNode.position = { x: 100, y: 100 + (productCount * 150) };
            productCount++;
        }
        newNodes.push(updatedNode);
      });

      // Inject connecting edges from folders to their primary contents if missing
      const firstProduct = newNodes.find(n => n.parentId === 'f_products' && n.id !== 'f_products');
      if (firstProduct) {
          newEdges.push({ id: `e_fold_prod_init`, source: 'f_products', target: firstProduct.id, animated: true });
      }
      const firstSupport = newNodes.find(n => n.parentId === 'f_support' && n.id !== 'f_support');
      if (firstSupport) {
          newEdges.push({ id: `e_fold_supp_init`, source: 'f_support', target: firstSupport.id, animated: true });
      }

      await Client.updateOne({ clientId }, { $set: { flowNodes: newNodes, flowEdges: newEdges } });
      console.log(`Successfully folderized ${clientId}`);
    }

    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

folderize();
