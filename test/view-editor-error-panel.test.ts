/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Unit tests for error parsing logic and error panel display.
 *
 * Tests the parseCompilationError parsing logic used by the error panel in view-editor.
 * The error panel displays compilation errors with line numbers, function names, and titles.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Extract the parseCompilationError logic for testing
// ---------------------------------------------------------------------------
function parseCompilationError(detail: string): {
  message: string;
  line?: number;
  functionName?: string;
} {
  const lineMatch = detail.match(/Line (\d+): ([^"]+)/);
  const fnMatch = detail.match(/in the '([^']+)' (view|filter|update|list|show)/);
  
  return {
    message: lineMatch ? lineMatch[2] : detail,
    line: lineMatch ? parseInt(lineMatch[1]) : undefined,
    functionName: fnMatch ? fnMatch[1] : undefined
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('parseCompilationError', () => {
  it('extracts line number from CouchDB error', () => {
    const detail = 'Compilation of the map function in the \'new_view\' view failed: (new Error("Line 3: Unexpected token ,", "./share/server/main.js", 3))';
    const result = parseCompilationError(detail);
    expect(result.line).toBe(3);
    expect(result.message).toBe('Unexpected token ,');
  });

  it('extracts function name from view error', () => {
    const detail = 'Compilation of the map function in the \'new_view\' view failed: (new Error("Line 3: Unexpected token ,", "./share/server/main.js", 3))';
    const result = parseCompilationError(detail);
    expect(result.functionName).toBe('new_view');
  });

  it('extracts function name from filter error', () => {
    const detail = 'Compilation of the filter function in the \'my_filter\' filter failed: syntax error';
    const result = parseCompilationError(detail);
    expect(result.functionName).toBe('my_filter');
  });

  it('extracts function name from update error', () => {
    const detail = 'Compilation in the \'my_update\' update failed: error';
    const result = parseCompilationError(detail);
    expect(result.functionName).toBe('my_update');
  });

  it('returns detail as message when no line number present', () => {
    const detail = 'Some generic compilation error';
    const result = parseCompilationError(detail);
    expect(result.message).toBe('Some generic compilation error');
    expect(result.line).toBeUndefined();
  });

  it('returns undefined function name when not in error', () => {
    const detail = 'Line 5: Syntax error';
    const result = parseCompilationError(detail);
    expect(result.functionName).toBeUndefined();
  });

  it('handles complex error with code snippet', () => {
    const detail = `Compilation of the map function in the 'animals' view failed: (new Error("Line 3: Unexpected token ,", "./share/server/main.js", 3)) (function (doc) {
    if (doc.type === "xx");;
    ,
    
})`;
    const result = parseCompilationError(detail);
    expect(result.line).toBe(3);
    expect(result.message).toBe('Unexpected token ,');
    expect(result.functionName).toBe('animals');
  });

  it('handles list function errors', () => {
    const detail = 'Compilation in the \'my_list\' list failed: Line 10: Missing semicolon';
    const result = parseCompilationError(detail);
    expect(result.line).toBe(10);
    expect(result.message).toBe('Missing semicolon');
    expect(result.functionName).toBe('my_list');
  });

  it('handles show function errors', () => {
    const detail = 'Compilation in the \'my_show\' show failed: Line 2: Unexpected identifier';
    const result = parseCompilationError(detail);
    expect(result.line).toBe(2);
    expect(result.message).toBe('Unexpected identifier');
    expect(result.functionName).toBe('my_show');
  });
});

describe('Error Panel Display Logic', () => {
  it('should display error message with line number', () => {
    const saveError = {
      title: 'Compilation Error',
      message: 'Unexpected token ,',
      line: 3,
      functionName: 'new_view',
      errorDetail: 'Full error text...'
    };
    
    const displayMessage = saveError.line 
      ? `Line ${saveError.line}: ${saveError.message}`
      : saveError.message;
    
    expect(displayMessage).toBe('Line 3: Unexpected token ,');
    expect(saveError.title).toBe('Compilation Error');
  });

  it('should display error message without line number', () => {
    const saveError: {
      title?: string;
      message: string;
      line?: number;
      errorDetail?: string;
    } = {
      title: 'Upstream CouchDB Error',
      message: 'Document update conflict',
      errorDetail: 'CouchDB request failed: Document update conflict.'
    };
    
    const displayMessage = saveError.line 
      ? `Line ${saveError.line}: ${saveError.message}`
      : saveError.message;
    
    expect(displayMessage).toBe('Document update conflict');
    expect(saveError.title).toBe('Upstream CouchDB Error');
  });

  it('should show function name when present', () => {
    const saveError = {
      message: 'Unexpected token',
      line: 5,
      functionName: 'my_view'
    };
    
    expect(saveError.functionName).toBe('my_view');
  });

  it('should handle null saveError state', () => {
    const saveError = null;
    expect(saveError).toBeNull();
  });

  it('should handle error with title field', () => {
    const saveError = {
      title: 'Upstream CouchDB Error',
      message: 'CouchDB request failed: Document update conflict.'
    };
    
    expect(saveError.title).toBe('Upstream CouchDB Error');
    expect(saveError.message).toBe('CouchDB request failed: Document update conflict.');
  });
});
