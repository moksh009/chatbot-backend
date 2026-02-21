const express = require('express');
const router = express.Router();
const Provider = require('../models/Provider');
const Service = require('../models/Service');

// --- PROVIDER ROUTES ---

// Get all providers for a client
router.get('/providers', async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) return res.status(400).json({ error: 'clientId is required' });

        // Default system clientId fallback if not provided properly
        const id = clientId === 'code_clinic_v1' || !clientId ? 'delitech_smarthomes' : clientId;

        const providers = await Provider.find({ clientId: id }).sort({ createdAt: -1 });
        res.json(providers);
    } catch (error) {
        console.error('Error fetching providers:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create a new provider
router.post('/providers', async (req, res) => {
    try {
        const { clientId, name, role, isActive } = req.body;
        if (!clientId || !name) return res.status(400).json({ error: 'clientId and name are required' });

        const newProvider = new Provider({ clientId, name, role, isActive });
        await newProvider.save();

        res.status(201).json(newProvider);
    } catch (error) {
        console.error('Error creating provider:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update a provider
router.put('/providers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, role, isActive } = req.body;

        const provider = await Provider.findByIdAndUpdate(
            id,
            { name, role, isActive },
            { new: true }
        );

        if (!provider) return res.status(404).json({ error: 'Provider not found' });
        res.json(provider);
    } catch (error) {
        console.error('Error updating provider:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete a provider
router.delete('/providers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const provider = await Provider.findByIdAndDelete(id);

        if (!provider) return res.status(404).json({ error: 'Provider not found' });
        res.json({ message: 'Provider deleted successfully' });
    } catch (error) {
        console.error('Error deleting provider:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- SERVICE ROUTES ---

// Get all services for a client
router.get('/services', async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) return res.status(400).json({ error: 'clientId is required' });

        const id = clientId === 'code_clinic_v1' || !clientId ? 'delitech_smarthomes' : clientId;

        const services = await Service.find({ clientId: id }).sort({ createdAt: -1 });
        res.json(services);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create a new service
router.post('/services', async (req, res) => {
    try {
        const { clientId, name, price, duration, isActive } = req.body;
        if (!clientId || !name) return res.status(400).json({ error: 'clientId and name are required' });

        const newService = new Service({ clientId, name, price, duration, isActive });
        await newService.save();

        res.status(201).json(newService);
    } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update a service
router.put('/services/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, duration, isActive } = req.body;

        const service = await Service.findByIdAndUpdate(
            id,
            { name, price, duration, isActive },
            { new: true }
        );

        if (!service) return res.status(404).json({ error: 'Service not found' });
        res.json(service);
    } catch (error) {
        console.error('Error updating service:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete a service
router.delete('/services/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const service = await Service.findByIdAndDelete(id);

        if (!service) return res.status(404).json({ error: 'Service not found' });
        res.json({ message: 'Service deleted successfully' });
    } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
