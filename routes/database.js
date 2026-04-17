const mongoose = require('mongoose');

module.exports = async function (fastify, opts) {
    // All routes in this file require SUPER_MASTER role
    fastify.addHook('preHandler', fastify.requireSuperMaster);

    /**
     * GET /api/database/collections
     * Returns a list of all collections in the database
     */
    fastify.get('/collections', async (request, reply) => {
        try {
            const collections = await mongoose.connection.db.listCollections().toArray();
            return { success: true, collections: collections.map(c => c.name) };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch collections' });
        }
    });

    /**
     * GET /api/database/:collection
     * Returns documents for a specific collection
     */
    fastify.get('/:collection', async (request, reply) => {
        const { collection } = request.params;
        const { page = 1, limit = 20, search = '' } = request.query;

        try {
            const Model = mongoose.connection.models[collection] || mongoose.model(collection, new mongoose.Schema({}, { strict: false }), collection);
            
            let query = {};
            if (search) {
                // Basic search logic - can be improved
                query = { $or: [{ _id: mongoose.isValidObjectId(search) ? search : null }, { name: new RegExp(search, 'i') }] };
            }

            const docs = await Model.find(query)
                .limit(parseInt(limit))
                .skip((parseInt(page) - 1) * parseInt(limit))
                .lean();

            const total = await Model.countDocuments(query);

            return { success: true, documents: docs, total, page: parseInt(page), limit: parseInt(limit) };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: `Failed to fetch documents from ${collection}` });
        }
    });

    /**
     * POST /api/database/:collection
     * Create a new document in a collection
     */
    fastify.post('/:collection', async (request, reply) => {
        const { collection } = request.params;
        const data = request.body;

        try {
            const Model = mongoose.connection.models[collection] || mongoose.model(collection, new mongoose.Schema({}, { strict: false }), collection);
            const newDoc = new Model(data);
            await newDoc.save();
            return { success: true, document: newDoc };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: `Failed to create document in ${collection}` });
        }
    });

    /**
     * PUT/PATCH /api/database/:collection/:id
     * Update a document in a collection (supports partial updates)
     */
    fastify.route({
        method: ['PUT', 'PATCH'],
        url: '/:collection/:id',
        handler: async (request, reply) => {
            const { collection, id } = request.params;
            const data = request.body;

            try {
                const Model = mongoose.connection.models[collection] || mongoose.model(collection, new mongoose.Schema({}, { strict: false }), collection);
                
                // Remove immutable/meta fields from the update payload if present
                const updateData = { ...data };
                delete updateData._id;
                delete updateData.createdAt;
                delete updateData.updatedAt;
                delete updateData.__v;

                const updatedDoc = await Model.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true });
                if (!updatedDoc) return reply.code(404).send({ error: 'Document not found' });
                return { success: true, document: updatedDoc };
            } catch (error) {
                fastify.log.error(error);
                return reply.code(500).send({ error: `Failed to update document in ${collection}` });
            }
        }
    });

    /**
     * DELETE /api/database/:collection/:id
     * Delete a document in a collection
     */
    fastify.delete('/:collection/:id', async (request, reply) => {
        const { collection, id } = request.params;

        try {
            const Model = mongoose.connection.models[collection] || mongoose.model(collection, new mongoose.Schema({}, { strict: false }), collection);
            const deletedDoc = await Model.findByIdAndDelete(id);
            if (!deletedDoc) return reply.code(404).send({ error: 'Document not found' });
            return { success: true, message: 'Document deleted successfully' };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: `Failed to delete document from ${collection}` });
        }
    });
};
