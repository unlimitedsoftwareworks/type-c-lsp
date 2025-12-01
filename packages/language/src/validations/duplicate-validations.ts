/**
 * (c) Copyright 2025 Soulaymen Chouri.
 * This software is licensed under the Apache License 2.0.
 * See the LICENSE.md file in the project root for details.
 */

import { ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCBaseValidation } from "./base-validation.js";
import { ErrorCode } from "../codes/errors.js";

/**
 * Validator for duplicate declarations.
 *
 * Currently validates:
 * - Duplicate function parameter names at the same level
 * - Duplicate function type parameter names (when names are present)
 * - Duplicate variable declarations within the same scope
 * - Duplicate struct field names in struct type definitions
 * - Duplicate field names in struct construction expressions
 *
 * Examples:
 * ```tc
 * fn add(a: u32, a: u32) -> u32 { ... }  // ❌ Error - duplicate parameter 'a'
 * fn add(a: u32, b: u32) -> u32 { ... }  // ✅ OK - unique parameters
 * 
 * type Callback = fn(x: u32, x: u32) -> void  // ❌ Error - duplicate parameter 'x'
 * type Callback = fn(u32, u32) -> void        // ✅ OK - unnamed parameters
 * type Callback = fn(x: u32, y: u32) -> void  // ✅ OK - unique named parameters
 *
 * type Point = struct { x: u32, x: u32 }  // ❌ Error - duplicate field 'x'
 * type Point = struct { x: u32, y: u32 }  // ✅ OK - unique fields
 *
 * let p = {x: 1, x: 2}  // ❌ Error - duplicate field 'x' in construction
 * let p = {...base, x: 1, x: 2}  // ❌ Error - duplicate field 'x' after spread
 *
 * let x = 1, x = 2  // ❌ Error - duplicate variable 'x' in same statement
 * let x = 1; let x = 2  // ❌ Error - duplicate variable 'x' in same scope
 * { let x = 1 } { let x = 1 }  // ✅ OK - different scopes
 * let x = 1; { let x = 2 }  // ✅ OK - shadowing allowed
 * ```
 */
export class DuplicateValidator extends TypeCBaseValidation {
    constructor(services: TypeCServices) {
        super();
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            FunctionDeclaration: this.checkFunctionParameters,
            MethodHeader: this.checkMethodParameters,
            LambdaExpression: this.checkLambdaParameters,
            FunctionType: this.checkFunctionTypeParameters,
            VariablesDeclarations: this.checkVariableDeclarationsInStatement,
            Module: this.checkVariablesInScope,
            NamespaceDecl: this.checkVariablesInScope,
            BlockStatement: this.checkVariablesInScope,
            StructType: this.checkStructTypeFields,
            NamedStructConstructionExpression: this.checkStructConstructionFields
        };
    }

    /**
     * Check for duplicate parameters in function declarations.
     */
    checkFunctionParameters = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        this.checkParameterDuplicates(node.header.args, accept);
    }

    /**
     * Check for duplicate parameters in method headers (class/interface methods).
     */
    checkMethodParameters = (node: ast.MethodHeader, accept: ValidationAcceptor): void => {
        if (node.header?.args) {
            this.checkParameterDuplicates(node.header.args, accept);
        }
    }

    /**
     * Check for duplicate parameters in lambda expressions.
     */
    checkLambdaParameters = (node: ast.LambdaExpression, accept: ValidationAcceptor): void => {
        this.checkParameterDuplicates(node.header.args, accept);
    }

    /**
     * Check for duplicate parameters in function type headers.
     * Note: Function type parameters can have optional names, so we only validate when names are present.
     */
    checkFunctionTypeParameters = (node: ast.FunctionType, accept: ValidationAcceptor): void => {
        if (ast.isFunctionTypeHeader(node.header)) {
            // FunctionTypeHeader with FunctionTypeParameter (optional names)
            this.checkFunctionTypeParameterDuplicates(node.header.args, accept);
        } else if (ast.isFunctionHeader(node.header)) {
            // FunctionHeader with FunctionParameter (required names)
            this.checkParameterDuplicates(node.header.args, accept);
        }
    }

    /**
     * Check for duplicate variable declarations within a single let statement.
     * Example: let x = 1, x = 2
     * Also checks for duplicates within a single destructuring pattern.
     * Example: let {name, name} = {...}
     */
    checkVariableDeclarationsInStatement = (node: ast.VariablesDeclarations, accept: ValidationAcceptor): void => {
        const seenNamesAcrossDecls = new Map<string, ast.VariableDeclaration>();

        for (const varDecl of node.variables) {
            // First, check for duplicates WITHIN this single declaration's destructuring
            this.checkDuplicatesWithinDeclaration(varDecl, accept);
            
            // Then extract all variable names from this declaration
            const names = this.extractVariableNames(varDecl);
            
            // Check for duplicates ACROSS different declarations in the same let statement
            for (const name of names) {
                if (seenNamesAcrossDecls.has(name)) {
                    // Found a duplicate across different declarations in same let statement
                    const errorCode = ErrorCode.TC_DUPLICATE_VARIABLE_DECLARATION;
                    accept('error',
                        `Duplicate variable '${name}': Variable is already declared in this statement.`,
                        {
                            node: varDecl,
                            property: 'name',
                            code: errorCode
                        }
                    );
                } else {
                    seenNamesAcrossDecls.set(name, varDecl);
                }
            }
        }
    }

    /**
     * Check for duplicate variable declarations across different statements in the same scope.
     * This checks Module, Namespace, and BlockStatement scopes.
     *
     * Strategy: Register all functions first, then validate variables against them.
     * This ensures variables cannot shadow functions at the same level.
     */
    checkVariablesInScope = (node: ast.Module | ast.NamespaceDecl | ast.BlockStatement, accept: ValidationAcceptor): void => {
        const seenVariables = new Map<string, ast.VariableDeclaration>();
        const seenFunctions = new Map<string, ast.FunctionDeclaration>();

        // Get all definitions/statements in this scope
        const items = this.getItemsInScope(node);

        // FIRST PASS: Register all function names
        // This ensures functions are known before we check variables
        for (const item of items) {
            if (ast.isFunctionDeclaration(item)) {
                // Direct FunctionDeclaration (Module/Namespace level)
                const fnName = item.name;
                if (!seenFunctions.has(fnName)) {
                    seenFunctions.set(fnName, item);
                }
            } else if (ast.isFunctionDeclarationStatement(item)) {
                // FunctionDeclarationStatement (BlockStatement level)
                const fnName = item.fn.name;
                if (!seenFunctions.has(fnName)) {
                    seenFunctions.set(fnName, item.fn);
                }
            }
        }

        // SECOND PASS: Validate variable declarations
        // Check against both previously declared variables and all functions
        for (const item of items) {
            if (ast.isVariableDeclarationStatement(item)) {
                // Process variable declarations
                for (const varDecl of item.declarations.variables) {
                    const names = this.extractVariableNames(varDecl);
                    
                    for (const name of names) {
                        if (seenVariables.has(name)) {
                            // Found a duplicate variable in the same scope
                            const errorCode = ErrorCode.TC_DUPLICATE_VARIABLE_DECLARATION;
                            accept('error',
                                `Duplicate variable '${name}': Variable is already declared in this scope.`,
                                {
                                    node: varDecl,
                                    property: 'name',
                                    code: errorCode
                                }
                            );
                        } else if (seenFunctions.has(name)) {
                            // Variable conflicts with function name
                            const errorCode = ErrorCode.TC_DUPLICATE_VARIABLE_DECLARATION;
                            accept('error',
                                `Duplicate declaration '${name}': Name is already used by a function in this scope.`,
                                {
                                    node: varDecl,
                                    property: 'name',
                                    code: errorCode
                                }
                            );
                        } else {
                            seenVariables.set(name, varDecl);
                        }
                    }
                }
            }
        }
    }

    /**
     * Check a list of parameters for duplicates.
     * Reports an error for each duplicate parameter found.
     */
    private checkParameterDuplicates(
        parameters: ast.FunctionParameter[],
        accept: ValidationAcceptor
    ): void {
        // Track parameter names we've seen
        const seenNames = new Map<string, ast.FunctionParameter>();

        for (const param of parameters) {
            const paramName = param.name;
            
            if (seenNames.has(paramName)) {
                // Found a duplicate - report error on the current parameter
                const errorCode = ErrorCode.TC_DUPLICATE_FUNCTION_PARAMETER;
                accept('error',
                    `Duplicate parameter '${paramName}': Parameter names must be unique within the same function signature.`,
                    {
                        node: param,
                        property: 'name',
                        code: errorCode
                    }
                );
            } else {
                // First occurrence - track it
                seenNames.set(paramName, param);
            }
        }
    }

    /**
     * Check a list of function type parameters for duplicates.
     * Only validates parameters that have names (since names are optional in function types).
     */
    private checkFunctionTypeParameterDuplicates(
        parameters: ast.FunctionTypeParameter[],
        accept: ValidationAcceptor
    ): void {
        // Track parameter names we've seen (only for named parameters)
        const seenNames = new Map<string, ast.FunctionTypeParameter>();

        for (const param of parameters) {
            // Skip parameters without names
            if (!param.name) {
                continue;
            }

            const paramName = param.name;
            
            if (seenNames.has(paramName)) {
                // Found a duplicate - report error on the current parameter
                const errorCode = ErrorCode.TC_DUPLICATE_FUNCTION_PARAMETER;
                accept('error',
                    `Duplicate parameter '${paramName}': Parameter names must be unique within the same function signature.`,
                    {
                        node: param,
                        property: 'name',
                        code: errorCode
                    }
                );
            } else {
                // First occurrence - track it
                seenNames.set(paramName, param);
            }
        }
    }

    /**
     * Check for duplicate names within a single variable declaration's destructuring pattern.
     * Example: let {name, name} = {...} or let (t, t) = (...)
     */
    private checkDuplicatesWithinDeclaration(varDecl: ast.VariableDeclaration, accept: ValidationAcceptor): void {
        // Only check destructuring declarations (not simple variables)
        if (ast.isVariableDeclSingle(varDecl)) {
            return; // Simple variable, no destructuring to check
        }

        // Check array, struct, or tuple destructuring
        if (ast.isVariableDeclArrayDestructuring(varDecl) ||
            ast.isVariableDeclStructDestructuring(varDecl) ||
            ast.isVariableDeclTupleDestructuring(varDecl)) {
            
            const seenNames = new Map<string, ast.DestructuringElement>();

            for (const element of varDecl.elements) {
                if (ast.isDestructuringElement(element) && element.name && element.name !== '_') {
                    const name = element.name;
                    
                    if (seenNames.has(name)) {
                        // Found a duplicate within the same destructuring pattern
                        const errorCode = ErrorCode.TC_DUPLICATE_VARIABLE_DECLARATION;
                        accept('error',
                            `Duplicate variable '${name}': Variable appears multiple times in the same destructuring pattern.`,
                            {
                                node: element,
                                property: 'name',
                                code: errorCode
                            }
                        );
                    } else {
                        seenNames.set(name, element);
                    }
                }
            }
        }
    }

    /**
     * Extract all variable names from a variable declaration (handles destructuring).
     */
    private extractVariableNames(varDecl: ast.VariableDeclaration): string[] {
        const names: string[] = [];

        if (ast.isVariableDeclSingle(varDecl)) {
            // Simple variable
            names.push(varDecl.name);
        }
        else if (ast.isVariableDeclArrayDestructuring(varDecl) ||
                ast.isVariableDeclStructDestructuring(varDecl) ||
                ast.isVariableDeclTupleDestructuring(varDecl)) {
            // Array, struct, or tuple destructuring
            for (const element of varDecl.elements) {
                if (ast.isDestructuringElement(element) && element.name && element.name !== '_') {
                    names.push(element.name);
                }
            }
        }

        return names;
    }

    /**
     * Get all items in a scope (Module, Namespace, or BlockStatement).
     * Returns both FunctionDeclaration (module/namespace level) and FunctionDeclarationStatement (block level).
     */
    private getItemsInScope(node: ast.Module | ast.NamespaceDecl | ast.BlockStatement): Array<ast.FunctionDeclaration | ast.VariableDeclarationStatement | ast.FunctionDeclarationStatement> {
        const items: Array<ast.FunctionDeclaration | ast.VariableDeclarationStatement | ast.FunctionDeclarationStatement> = [];

        if (ast.isModule(node) || ast.isNamespaceDecl(node)) {
            // Module and Namespace have 'definitions'
            // At this level, functions are FunctionDeclaration directly
            for (const def of node.definitions) {
                if (ast.isVariableDeclarationStatement(def) || ast.isFunctionDeclaration(def)) {
                    items.push(def);
                }
            }
        } else if (ast.isBlockStatement(node)) {
            // BlockStatement has 'statements'
            // At this level, functions are wrapped in FunctionDeclarationStatement
            for (const stmt of node.statements) {
                if (ast.isVariableDeclarationStatement(stmt) || ast.isFunctionDeclarationStatement(stmt)) {
                    items.push(stmt);
                }
            }
        }

        return items;
    }

    /**
     * Check for duplicate field names in struct type definitions.
     * Example: type Point = struct { x: u32, x: u32 }
     */
    checkStructTypeFields = (node: ast.StructType, accept: ValidationAcceptor): void => {
        const seenFields = new Map<string, ast.StructField>();

        for (const field of node.fields) {
            const fieldName = field.name;
            
            if (seenFields.has(fieldName)) {
                // Found a duplicate field in the struct type definition
                const errorCode = ErrorCode.TC_DUPLICATE_STRUCT_FIELD;
                accept('error',
                    `Duplicate field '${fieldName}': Field is already defined in this struct type.`,
                    {
                        node: field,
                        property: 'name',
                        code: errorCode
                    }
                );
            } else {
                seenFields.set(fieldName, field);
            }
        }
    }

    /**
     * Check for duplicate field names in struct construction expressions.
     * Handles both regular fields and spread expressions.
     * Example: let p = {x: 1, x: 2} or let p = {...base, x: 1, x: 2}
     */
    checkStructConstructionFields = (node: ast.NamedStructConstructionExpression, accept: ValidationAcceptor): void => {
        const seenFields = new Map<string, ast.StructFieldKeyValuePair>();

        for (const field of node.fields) {
            // Skip spread expressions - they don't define duplicate keys themselves
            if (ast.isStructSpreadExpression(field)) {
                continue;
            }

            if (ast.isStructFieldKeyValuePair(field)) {
                const fieldName = field.name;
                
                if (seenFields.has(fieldName)) {
                    // Found a duplicate field in the struct construction
                    const errorCode = ErrorCode.TC_DUPLICATE_STRUCT_CONSTRUCTION_FIELD;
                    accept('error',
                        `Duplicate field '${fieldName}': Field is already defined in this struct construction.`,
                        {
                            node: field,
                            property: 'name',
                            code: errorCode
                        }
                    );
                } else {
                    seenFields.set(fieldName, field);
                }
            }
        }
    }
}