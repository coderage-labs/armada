/**
 * Tests for #22: Verify no duplicate pending mutations are created
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { workingCopy } from '../working-copy.js';
import { pendingMutationRepo } from '../../repositories/pending-mutation-repo.js';

describe('Working Copy — No Duplicate Mutations (#22)', () => {
  beforeEach(() => {
    setupTestDb();
    workingCopy.discard(); // Clear working copy before each test
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('creating the same entity multiple times should not create duplicate mutations', () => {
    const templateId = 'test-template-1';
    const templateData = {
      name: 'Test Template',
      description: 'A test template',
      role: 'dev',
    };

    // Create the same template 3 times (simulating multiple API calls)
    workingCopy.create('template', templateId, templateData);
    workingCopy.create('template', templateId, templateData);
    workingCopy.create('template', templateId, templateData);

    // Check pending mutations — should only have ONE mutation for this template
    const allMutations = pendingMutationRepo.getAll();
    const templateMutations = allMutations.filter(
      (m) => m.entityType === 'template' && m.entityId === templateId
    );

    expect(templateMutations.length).toBe(1);
    expect(templateMutations[0]!.action).toBe('create');
  });

  it('updating the same entity multiple times should not create duplicate mutations', () => {
    const templateId = 'test-template-2';
    
    // First create a template
    workingCopy.create('template', templateId, {
      name: 'Original',
      description: 'Original description',
      role: 'dev',
    });

    // Clear mutations to simulate a clean state
    workingCopy.discard();
    
    // Create again (simulating it exists in committed DB)
    workingCopy.create('template', templateId, {
      name: 'Original',
      description: 'Original description',
      role: 'dev',
    });

    // Now update it 3 times
    workingCopy.update('template', templateId, { name: 'Updated 1' });
    workingCopy.update('template', templateId, { name: 'Updated 2' });
    workingCopy.update('template', templateId, { name: 'Updated 3' });

    // Check pending mutations — should only have ONE mutation for this template
    const allMutations = pendingMutationRepo.getAll();
    const templateMutations = allMutations.filter(
      (m) => m.entityType === 'template' && m.entityId === templateId
    );

    expect(templateMutations.length).toBe(1);
    expect(templateMutations[0]!.action).toBe('create'); // Still a create since it's in working copy
    expect(templateMutations[0]!.payload.name).toBe('Updated 3'); // Should have the latest value
  });

  it('staging 3 templates should create exactly 3 mutations (one per template)', () => {
    // Simulate the scenario from the issue: staging 3 templates
    const templates = [
      { id: 't1', name: 'Template 1', description: 'First', role: 'dev' },
      { id: 't2', name: 'Template 2', description: 'Second', role: 'pm' },
      { id: 't3', name: 'Template 3', description: 'Third', role: 'qa' },
    ];

    // Stage each template
    for (const template of templates) {
      workingCopy.create('template', template.id, template);
    }

    // Check total mutations — should be exactly 3
    const allMutations = pendingMutationRepo.getAll();
    const templateMutations = allMutations.filter((m) => m.entityType === 'template');

    expect(templateMutations.length).toBe(3);
    
    // Verify each template has exactly one mutation
    for (const template of templates) {
      const mutationsForTemplate = templateMutations.filter(
        (m) => m.entityId === template.id
      );
      expect(mutationsForTemplate.length).toBe(1);
    }
  });

  it('repo.create with duplicate (same changeset + entity + action) should update, not duplicate', () => {
    const changesetId = 'test-changeset';
    const entityType = 'template';
    const entityId = 'test-template';

    // Create the same mutation 3 times directly via repo
    pendingMutationRepo.create({
      changesetId,
      entityType,
      entityId,
      action: 'create',
      payload: { name: 'First' },
      instanceId: null,
    });

    pendingMutationRepo.create({
      changesetId,
      entityType,
      entityId,
      action: 'create',
      payload: { name: 'Second' },
      instanceId: null,
    });

    pendingMutationRepo.create({
      changesetId,
      entityType,
      entityId,
      action: 'create',
      payload: { name: 'Third' },
      instanceId: null,
    });

    // Should only have ONE mutation
    const mutations = pendingMutationRepo.getByChangeset(changesetId);
    expect(mutations.length).toBe(1);
    
    // Should have the latest payload
    expect(mutations[0]!.payload.name).toBe('Third');
  });
});
