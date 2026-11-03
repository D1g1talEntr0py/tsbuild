import { afterAll } from 'vitest';
import { TestHelper } from './test-helper';

afterAll(() => { TestHelper.closeApi() });
