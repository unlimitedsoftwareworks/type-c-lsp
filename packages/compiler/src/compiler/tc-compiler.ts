/**
 * IR Generator for Type-C
 * Generates typed Intermediate Representation from Type-C AST
 */

import { AstNode, AstUtils, LangiumDocument } from 'langium';
import * as ast from 'type-c-language/ast';
import { TypeCServices } from 'type-c-language';
import {
    IRFunction,
    IRProgram,
    scalarType,
    ptrType,
    voidType,
    isSignedInt,
    isInteger,
    isScalar,
    isFloat,
    isDouble,
    serializeFunction,
    serializeIRType
} from '../ir/index.js';
import type {
    IRType,
    NumericType,
    CmpType,
    IntType,
    FloatType,
    CastKind,
    FunctionParam,
    VReg,
    ScalarIRType,
    ClassFieldShape,
    ClassMethodShape
} from '../ir/index.js';
import {
    TypeDescription,
    TypeKind,
    isGenericType,
    isIntegerType,
    isFloatType,
    isErrorType,
    isNeverType,
    isArrayType,
    isNullableType,
    isTupleType,
    isReferenceType,
    isStructType,
    isFunctionType,
    isUnionType,
    isJoinType,
    isClassType,
    isInterfaceType,
    isVariantType,
    isVariantConstructorType,
    isFFIType,
    isCoroutineType,
    isStringType,
    isStringLiteralType,
    getMinArity
} from 'type-c-language/types';
import type {
    VariantConstructorTypeDescription,
    EnumTypeDescription,
    ClassTypeDescription,
    InterfaceTypeDescription,
    StructTypeDescription,
    ArrayTypeDescription,
    FFITypeDescription
} from 'type-c-language/types';
import {
    TypeCTypeProvider,
    MonomorphizationRegistry,
    TypeCTypeUtils
} from 'type-c-language/services';
import { FFIRegistery } from './ffi-registry.js';
import { GlobalVariablesRegistery } from './global-vars-registry.js';
import { CallableRegistry } from './callable-registry.js';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Context for tracking code generation state
 */
interface GenerationContext {
    currentFunction: IRFunction | null;
    variables: Map<string, { register: VReg; type: IRType }>;
    tempCounter: number;
    labelCounter: number;
    loopStack: Array<{ breakLabel: string; continueLabel: string }>;
    scopeDepth: number;
    /** Stack of variable scopes for cleanup on scope exit */
    scopeVarStack: string[][];
}

/**
 * Result of expression generation
 */
interface ExpressionResult {
    register: VReg;
    type: IRType;
}

/**
 * Upvalue captured by a closure
 */
interface CapturedUpvalue {
    name: string;
    register: VReg;
    type: IRType;
}

// ============================================================================
// IR Generator
// ============================================================================

/**
 * IR Generator
 * Converts Type-C AST nodes into typed IR instructions
 */
export class IRGenerator {
    private program: IRProgram;
    private context: GenerationContext;
    readonly typeProvider: TypeCTypeProvider;
    readonly monoMorph: MonomorphizationRegistry;
    readonly typeUtils: TypeCTypeUtils;

    ffiRegistery: FFIRegistery = new FFIRegistery();

    globalVariablesRegistry: GlobalVariablesRegistery = new GlobalVariablesRegistery();
    G(node: AstNode, name?: string) {
        return this.globalVariablesRegistry.G(node, name);
    }

    callableRegistry!: CallableRegistry;
    C(node: AstNode, name?: string) {
        return this.callableRegistry.C(node, name);
    }

    /**
     * Global init function - instructions will be unwrapped later
     */
    globalFunc: IRFunction = new IRFunction("$G", [], []);

    /**
     * Stack of generic substitutions.
     */
    private substitutionStack: Map<string, TypeDescription>[] = [];

    /** Counter for generating unique closure names */
    private closureCounter = 0;

    private structShapeCounter = 0;

    /** Maps field name string → unique numeric ID for graph coloring */
    private fieldNameToId = new Map<string, number>();
    private fieldNameIdCounter = 0;

    private getOrCreateFieldNameId(name: string): number {
        let id = this.fieldNameToId.get(name);
        if (id === undefined) {
            id = this.fieldNameIdCounter++;
            this.fieldNameToId.set(name, id);
        }
        return id;
    }

    /** Maps method name string → unique numeric ID for method coloring */
    private methodNameToId = new Map<string, number>();
    private methodNameIdCounter = 0;

    private getOrCreateMethodNameId(name: string): number {
        let id = this.methodNameToId.get(name);
        if (id === undefined) {
            id = this.methodNameIdCounter++;
            if (id > 0xFFFF) {
                throw new Error(`Method name ID overflow: more than 65535 distinct method names`);
            }
            this.methodNameToId.set(name, id);
        }
        return id;
    }

    /** Maps class name string → sequential u16 UID for runtime type checks */
    private classNameToUid = new Map<string, number>();
    private classUidCounter = 0;

    private getOrCreateClassUid(name: string): number {
        let uid = this.classNameToUid.get(name);
        if (uid === undefined) {
            uid = this.classUidCounter++;
            if (uid > 0xFFFF) {
                throw new Error(`Class UID overflow: more than 65535 distinct class names`);
            }
            this.classNameToUid.set(name, uid);
        }
        return uid;
    }

    /** Maps class TypeDeclaration node → IR class name (for direct method dispatch) */
    private classNodeToIRName = new Map<ast.TypeDeclaration, string>();
    private readonly verboseIR = process.env.TYPEC_VERBOSE_IR === '1';

    constructor(services: TypeCServices) {
        this.program = new IRProgram();
        this.context = this.createContext();
        this.typeProvider = services.typing.TypeProvider;
        this.monoMorph = services.typing.MonomorphizationRegistry;
        this.typeUtils = services.typing.TypeUtils;
        this.callableRegistry = new CallableRegistry(this.monoMorph);
    }

    private debugIR(message: string): void {
        if (this.verboseIR) {
            console.log(message);
        }
    }

    private debugIRFunction(func: IRFunction): void {
        if (this.verboseIR) {
            console.log(serializeFunction(func));
        }
    }

    // ============================================================================
    // Generic Substitution Stack
    // ============================================================================

    private pushSubstitutions(substitutions: Map<string, TypeDescription>): void {
        this.substitutionStack.push(substitutions);
    }

    private popSubstitutions(): void {
        this.substitutionStack.pop();
    }

    private getCurrentSubstitutions(): Map<string, TypeDescription> {
        if (this.substitutionStack.length === 0) {
            return new Map();
        }
        const merged = new Map<string, TypeDescription>();
        for (const subs of this.substitutionStack) {
            for (const [key, value] of subs.entries()) {
                merged.set(key, value);
            }
        }
        return merged;
    }

    /**
     * Get the type of an AST node with automatic generic substitution.
     */
    private getType(node: AstNode): TypeDescription {
        const type = this.typeProvider.getType(node);

        const unresolvedInType = this.getUnresolvedGenerics(type);
        if (unresolvedInType.length === 0) {
            return type;
        }

        const substitutions = this.getCurrentSubstitutions();
        if (substitutions.size > 0) {
            const resolvedType = this.typeUtils.substituteGenerics(type, substitutions);
            const unresolvedGenerics = this.getUnresolvedGenerics(resolvedType);
            if (unresolvedGenerics.length > 0) {
                throw new Error(
                    `Unresolved generic type parameters in ${node.$type}: ${unresolvedGenerics.join(', ')}. ` +
                    `Available substitutions: ${Array.from(substitutions.keys()).join(', ') || 'none'}`
                );
            }
            return resolvedType;
        }

        throw new Error(
            `Found generic type parameters but no substitution context: ${unresolvedInType.join(', ')} in ${node.$type}`
        );
    }

    private isUnsuffixedNumericLiteral(arg: ast.Expression): boolean {
        if (ast.isIntegerLiteral(arg)) {
            return !arg.value.match(/([iu])(8|16|32|64)$/);
        }
        if (ast.isFloatingPointLiteral(arg)) {
            return !ast.isFloatLiteral(arg);
        }
        return false;
    }

    private resolveGenericCallTypeArgs(
        node: ast.FunctionCall,
        genericParams: readonly ast.GenericType[],
        parameterTypes: readonly TypeDescription[]
    ): TypeDescription[] | undefined {
        if (genericParams.length === 0) return [];

        if (node.genericArgs && node.genericArgs.length > 0) {
            if (node.genericArgs.length !== genericParams.length) {
                return undefined;
            }
            return node.genericArgs.map(ga => this.getType(ga));
        }

        const args = node.args || [];
        const genericParamNames = genericParams.map(p => p.name);
        const argumentTypes = args.map(arg => this.getType(arg));

        let substitutions = this.typeProvider.inferGenericsFromArguments(
            genericParamNames,
            [...parameterTypes],
            argumentTypes
        );

        const hasErrorSubstitution = Array.from(substitutions.values()).some(t => isErrorType(t));
        if (hasErrorSubstitution) {
            const concreteTypes = new Map<string, TypeDescription>();

            for (let i = 0; i < Math.min(args.length, parameterTypes.length); i++) {
                if (this.isUnsuffixedNumericLiteral(args[i])) continue;
                const paramType = parameterTypes[i];
                if (isGenericType(paramType) && genericParamNames.includes(paramType.name)) {
                    if (!concreteTypes.has(paramType.name)) {
                        concreteTypes.set(paramType.name, argumentTypes[i]);
                    }
                }
            }

            if (concreteTypes.size > 0) {
                let needsReInference = false;
                const newArgumentTypes = [...argumentTypes];

                for (let i = 0; i < Math.min(args.length, parameterTypes.length); i++) {
                    if (!this.isUnsuffixedNumericLiteral(args[i])) continue;
                    const paramType = parameterTypes[i];
                    if (isGenericType(paramType) && concreteTypes.has(paramType.name)) {
                        const contextType = concreteTypes.get(paramType.name)!;
                        if ((isIntegerType(contextType) || isFloatType(contextType)) && !isErrorType(contextType)) {
                            newArgumentTypes[i] = contextType;
                            needsReInference = true;
                        }
                    }
                }

                if (needsReInference) {
                    substitutions = this.typeProvider.inferGenericsFromArguments(
                        genericParamNames,
                        [...parameterTypes],
                        newArgumentTypes
                    );
                }
            }
        }

        const resolvedTypeArgs: TypeDescription[] = [];
        for (const name of genericParamNames) {
            const inferred = substitutions.get(name);
            if (!inferred || isErrorType(inferred) || isNeverType(inferred)) {
                return undefined;
            }
            resolvedTypeArgs.push(inferred);
        }

        return resolvedTypeArgs;
    }

    private getUnresolvedGenerics(type: TypeDescription): string[] {
        const generics: string[] = [];
        const traverse = (t: TypeDescription): void => {
            if (isGenericType(t)) {
                generics.push(t.name);
            } else if (isArrayType(t)) {
                traverse(t.elementType);
            } else if (isNullableType(t)) {
                traverse(t.baseType);
            } else if (isTupleType(t)) {
                t.elementTypes.forEach(traverse);
            } else if (isUnionType(t)) {
                t.types.forEach(traverse);
            } else if (isJoinType(t)) {
                t.types.forEach(traverse);
            } else if (isReferenceType(t)) {
                t.genericArgs.forEach(traverse);
            } else if (isStructType(t)) {
                t.fields.forEach(field => traverse(field.type));
            } else if (isFunctionType(t)) {
                t.parameters.forEach(param => traverse(param.type));
                traverse(t.returnType);
            }
        };
        traverse(type);
        return Array.from(new Set(generics));
    }

    // ============================================================================
    // Type Conversion Helpers
    // ============================================================================

    /**
     * Central mapping: TypeDescription → IRType
     */
    private convertTypeDescriptionToIR(type: TypeDescription): IRType {
        switch (type.kind) {
            case TypeKind.U8: return scalarType('u8');
            case TypeKind.U16: return scalarType('u16');
            case TypeKind.U32: return scalarType('u32');
            case TypeKind.U64: return scalarType('u64');
            case TypeKind.I8: return scalarType('i8');
            case TypeKind.I16: return scalarType('i16');
            case TypeKind.I32: return scalarType('i32');
            case TypeKind.I64: return scalarType('i64');
            case TypeKind.F32: return scalarType('f32');
            case TypeKind.F64: return scalarType('f64');
            case TypeKind.Bool: return scalarType('bool');
            case TypeKind.Void: return voidType();
            case TypeKind.String: return ptrType('string');
            case TypeKind.StringLiteral: return ptrType('string');
            case TypeKind.Null: return ptrType('struct'); // null ptr
            case TypeKind.Array: return ptrType('array');
            case TypeKind.Nullable: return this.convertTypeDescriptionToIR((type as any).baseType);
            case TypeKind.Struct: return ptrType('struct');
            case TypeKind.Class: return ptrType('class');
            case TypeKind.Interface: return ptrType('interface');
            case TypeKind.Variant: return ptrType('struct'); // variants are structs with tag
            case TypeKind.VariantConstructor: return ptrType('struct');
            case TypeKind.Enum: {
                const enumType = type as EnumTypeDescription;
                if (enumType.encoding) {
                    return this.convertTypeDescriptionToIR(enumType.encoding);
                }
                return scalarType('u32');
            }
            case TypeKind.Function: return ptrType('closure');
            case TypeKind.Coroutine: return ptrType('coroutine');
            case TypeKind.FFI: return ptrType('ffi_handle');
            case TypeKind.Reference: {
                // Resolve through type provider
                const resolved = this.typeUtils.resolveIfReference(type);
                if (resolved !== type) {
                    return this.convertTypeDescriptionToIR(resolved);
                }
                // Fallback for unresolvable references
                return ptrType('struct');
            }
            case TypeKind.Tuple: {
                // Tuples are only for returns - shouldn't typically hit this
                return voidType();
            }
            case TypeKind.Error:
                throw new Error(
                    `Cannot lower ErrorType to IR (${type.toString()}) at ${this.getSourceLocation(type.node)}`
                );
            case TypeKind.Never: return voidType();
            default: return voidType();
        }
    }

    /**
     * Get IRType for an AST node (resolves type then converts)
     */
    private getNodeIRType(node: AstNode): IRType {
        return this.convertTypeDescriptionToIR(this.getType(node));
    }

    /**
     * Convert AST DataType node to IRType using substitution stack
     */
    private convertTypeWithSubstitution(astType: ast.DataType): IRType {
        const resolvedType = this.getType(astType);
        return this.convertTypeDescriptionToIR(resolvedType);
    }

    /**
     * Get the current function or throw
     */
    private func(): IRFunction {
        if (!this.context.currentFunction) {
            throw new Error('No current function in context');
        }
        return this.context.currentFunction;
    }

    /**
     * Get a human-readable source location string for an AST node (for error messages).
     */
    private getSourceLocation(node?: AstNode): string {
        if (!node) return '<unknown location>';
        const cst = node.$cstNode;
        if (cst) {
            const range = cst.range;
            const doc = AstUtils.getDocument(node);
            const uri = doc?.uri?.path ?? '<unknown file>';
            return `${uri}:${range.start.line + 1}:${range.start.character + 1} (${node.$type})`;
        }
        return `<${node.$type}>`;
    }

    /**
     * Extract NumericType string from an IRType (for arithmetic/comparison)
     */
    private extractNumericType(irType: IRType, contextNode?: AstNode): NumericType {
        if (irType.tag === 'scalar') {
            const s = irType.scalar;
            if (s === 'bool') {
                return 'u8'; // treat bool as u8 for arithmetic
            }
            return s as NumericType;
        }
        throw new Error(`Cannot extract NumericType from ${serializeIRType(irType)} at ${this.getSourceLocation(contextNode)}`);
    }

    /**
     * Extract CmpType from an IRType (numeric or 'ptr')
     */
    private extractCmpType(irType: IRType, contextNode?: AstNode): CmpType {
        if (irType.tag === 'ptr') return 'ptr';
        return this.extractNumericType(irType, contextNode);
    }

    private coerceScalarExpression(value: ExpressionResult, targetType: IRType): ExpressionResult {
        if (!isScalar(value.type) || !isScalar(targetType)) {
            return value;
        }

        const srcScalar = (value.type as ScalarIRType).scalar;
        const tgtScalar = (targetType as ScalarIRType).scalar;
        if (srcScalar === tgtScalar) {
            if (value.type === targetType) {
                return value;
            }
            const temp = this.tmp();
            this.func().mov(temp, value.register, targetType);
            return { register: temp, type: targetType };
        }

        const temp = this.tmp();

        if (isInteger(value.type) && isInteger(targetType)) {
            const srcType = srcScalar as IntType;
            const tgtType = tgtScalar as IntType;
            const srcSize = this.intTypeSize(srcType);
            const tgtSize = this.intTypeSize(tgtType);
            const sameSignedness = (srcType.startsWith('i') && tgtType.startsWith('i')) ||
                (srcType.startsWith('u') && tgtType.startsWith('u'));

            if (!sameSignedness) {
                const castKind: CastKind = srcType.startsWith('i') ? 'i_u' : 'u_i';
                this.func().cast(temp, value.register, castKind);
            } else if (tgtSize > srcSize) {
                this.func().widen(temp, value.register, srcType, tgtType);
            } else {
                if (srcSize === 8) {
                    this.func().narrow(temp, value.register, srcType, tgtType);
                } else {
                    const widenedType: IntType = srcType.startsWith('i') ? 'i64' : 'u64';
                    const widenedReg = this.tmp();
                    this.func().widen(widenedReg, value.register, srcType, widenedType);
                    this.func().narrow(temp, widenedReg, widenedType, tgtType);
                }
            }

            return { register: temp, type: targetType };
        }

        if (isInteger(value.type) && (isFloat(targetType) || isDouble(targetType))) {
            const castKind: CastKind = isSignedInt(value.type)
                ? (isFloat(targetType) ? 'i_f' : 'i_d')
                : (isFloat(targetType) ? 'u_f' : 'u_d');
            this.func().cast(temp, value.register, castKind);
            return { register: temp, type: targetType };
        }

        if ((isFloat(value.type) || isDouble(value.type)) && isInteger(targetType)) {
            const castKind: CastKind = isSignedInt(targetType)
                ? (isFloat(value.type) ? 'f_i' : 'd_i')
                : (isFloat(value.type) ? 'f_u' : 'd_u');
            this.func().cast(temp, value.register, castKind);
            return { register: temp, type: targetType };
        }

        if (isFloat(value.type) && isDouble(targetType)) {
            this.func().cast(temp, value.register, 'f_d');
            return { register: temp, type: targetType };
        }

        if (isDouble(value.type) && isFloat(targetType)) {
            this.func().cast(temp, value.register, 'd_f');
            return { register: temp, type: targetType };
        }

        this.func().mov(temp, value.register, targetType);
        return { register: temp, type: targetType };
    }

    private intScalarBits(intType: IntType): 8 | 16 | 32 | 64 {
        switch (intType) {
            case 'i8':
            case 'u8':
                return 8;
            case 'i16':
            case 'u16':
                return 16;
            case 'i32':
            case 'u32':
                return 32;
            case 'i64':
            case 'u64':
                return 64;
        }
    }

    private intScalarFromShape(signed: boolean, bits: 8 | 16 | 32 | 64): IntType {
        if (signed) {
            switch (bits) {
                case 8: return 'i8';
                case 16: return 'i16';
                case 32: return 'i32';
                case 64: return 'i64';
            }
        }
        switch (bits) {
            case 8: return 'u8';
            case 16: return 'u16';
            case 32: return 'u32';
            case 64: return 'u64';
        }
    }

    private nextSignedBits(requiredBits: number): 8 | 16 | 32 | 64 | undefined {
        if (requiredBits <= 8) return 8;
        if (requiredBits <= 16) return 16;
        if (requiredBits <= 32) return 32;
        if (requiredBits <= 64) return 64;
        return undefined;
    }

    private resolveNumericOperandTypeFromIR(left: IRType, right: IRType): IRType | undefined {
        if (!isScalar(left) || !isScalar(right)) {
            return undefined;
        }

        const leftScalar = left.scalar;
        const rightScalar = right.scalar;

        // Keep bool out of arithmetic promotion. Let fallbacks handle non-numeric cases.
        if (leftScalar === 'bool' || rightScalar === 'bool') {
            return undefined;
        }

        if (leftScalar === 'f64' || rightScalar === 'f64') {
            return scalarType('f64');
        }
        if (leftScalar === 'f32' || rightScalar === 'f32') {
            return scalarType('f32');
        }

        const leftInt = leftScalar as IntType;
        const rightInt = rightScalar as IntType;
        const leftSigned = leftInt.startsWith('i');
        const rightSigned = rightInt.startsWith('i');
        const leftBits = this.intScalarBits(leftInt);
        const rightBits = this.intScalarBits(rightInt);

        if (leftSigned === rightSigned) {
            return scalarType(this.intScalarFromShape(leftSigned, leftBits >= rightBits ? leftBits : rightBits));
        }

        const maxSignedBits = leftSigned ? leftBits : rightBits;
        const maxUnsignedBits = leftSigned ? rightBits : leftBits;
        const signedBits = this.nextSignedBits(Math.max(maxSignedBits, maxUnsignedBits + 1));
        if (!signedBits) {
            return undefined;
        }

        return scalarType(this.intScalarFromShape(true, signedBits));
    }

    private resolveNumericOperandTypeForBinary(
        node: ast.BinaryExpression,
        left: ExpressionResult,
        right: ExpressionResult
    ): IRType {
        const promotedFromOperands = this.resolveNumericOperandTypeFromIR(left.type, right.type);
        if (promotedFromOperands) {
            return promotedFromOperands;
        }

        const nodeType = this.getType(node);
        if (nodeType.kind !== TypeKind.Error && nodeType.kind !== TypeKind.Bool) {
            const inferredNodeType = this.convertTypeDescriptionToIR(nodeType);
            if (isScalar(inferredNodeType) && inferredNodeType.scalar !== 'bool') {
                return inferredNodeType;
            }
        }

        const leftType = this.getType(node.left);
        const rightType = this.getType(node.right);
        const commonType = this.typeUtils.getCommonType([leftType, rightType]);
        if (commonType.kind !== TypeKind.Error) {
            const commonIrType = this.convertTypeDescriptionToIR(commonType);
            if (isScalar(commonIrType)) {
                return commonIrType;
            }
        }

        if (isScalar(left.type)) {
            return left.type;
        }

        if (isScalar(right.type)) {
            return right.type;
        }

        return left.type;
    }

    /**
     * Check if IRType is a string pointer
     */
    private isStringIRType(irType: IRType): boolean {
        return irType.tag === 'ptr' && irType.kind === 'string';
    }

    // isValueType removed - use IRType tag checks instead

    /**
     * Check if a type has an operator overload method.
     * Returns the method index and return type if found, undefined otherwise.
     * Mirrors the logic from TypeCTypeProvider.resolveOperatorOverload.
     */
    private resolveOperatorMethod(
        lhsTd: TypeDescription,
        operator: string,
        rhsTypes: TypeDescription[]
    ): { methodId: number; returnType: TypeDescription } | undefined {
        let resolved = isReferenceType(lhsTd) ? this.typeUtils.resolveIfReference(lhsTd) : lhsTd;

        // Unwrap nullable
        if (isNullableType(resolved)) {
            resolved = resolved.baseType;
        }

        // Resolve generic constraints (e.g., T: Addable → Addable)
        resolved = this.typeUtils.resolveIfGeneric(resolved);

        if (!isClassType(resolved) && !isInterfaceType(resolved)) {
            return undefined;
        }

        const typedDesc = resolved as ClassTypeDescription | InterfaceTypeDescription;
        const methods = typedDesc.methods;
        const operatorAliases = this.getOperatorAliases(operator);

        // Collect matching methods
        const candidates = methods
            .map((m) => ({ method: m }))
            .filter(({ method }) => method.names.some(name => operatorAliases.includes(name)));

        if (candidates.length === 0) return undefined;

        // Filter by argument count (accounts for default parameters)
        const argFiltered = candidates.filter(({ method }) => {
            const minArity = getMinArity(method.parameters);
            return rhsTypes.length >= minArity && rhsTypes.length <= method.parameters.length;
        });

        if (argFiltered.length === 0) return undefined;

        if (argFiltered.length === 1) {
            let returnType = argFiltered[0].method.returnType;
            // Apply generic substitutions if in generic context
            const subs = this.getCurrentSubstitutions();
            if (subs.size > 0) {
                returnType = this.typeUtils.substituteGenerics(returnType, subs);
            }
            const selectedMethodName = argFiltered[0].method.names[0] ?? operator;
            return { methodId: this.getOrCreateMethodNameId(selectedMethodName), returnType };
        }

        // Multiple candidates: try exact match first, then assignable
        for (const { method } of argFiltered) {
            if (method.parameters.every(
                (param, i) => this.typeUtils.areTypesEqual(rhsTypes[i], param.type).success
            )) {
                let returnType = method.returnType;
                const subs = this.getCurrentSubstitutions();
                if (subs.size > 0) {
                    returnType = this.typeUtils.substituteGenerics(returnType, subs);
                }
                const selectedMethodName = method.names[0] ?? operator;
                return { methodId: this.getOrCreateMethodNameId(selectedMethodName), returnType };
            }
        }

        for (const { method } of argFiltered) {
            if (method.parameters.every(
                (param, i) => this.typeUtils.isAssignable(rhsTypes[i], param.type).success
            )) {
                let returnType = method.returnType;
                const subs = this.getCurrentSubstitutions();
                if (subs.size > 0) {
                    returnType = this.typeUtils.substituteGenerics(returnType, subs);
                }
                const selectedMethodName = method.names[0] ?? operator;
                return { methodId: this.getOrCreateMethodNameId(selectedMethodName), returnType };
            }
        }

        return undefined;
    }

    private getOperatorAliases(operator: string): readonly string[] {
        switch (operator) {
            case '+':
                return ['+', '__add__', 'add', '__pos__', 'pos'];
            case '-':
                return ['-', '__sub__', 'sub', '__neg__', 'neg'];
            case '*':
                return ['*', '__mul__', 'mul'];
            case '/':
                return ['/', '__div__', 'div'];
            case '%':
                return ['%', '__mod__', 'mod'];
            case '==':
                return ['==', '__eq__', 'eq'];
            case '!=':
                return ['!=', '__neq__', '__ne__', 'neq', 'ne'];
            case '<':
                return ['<', '__lt__', 'lt'];
            case '<=':
                return ['<=', '__le__', 'le'];
            case '>':
                return ['>', '__gt__', 'gt'];
            case '>=':
                return ['>=', '__ge__', 'ge'];
            case '<<':
                return ['<<', '__shl__', 'shl'];
            case '>>':
                return ['>>', '__shr__', 'shr'];
            case '&':
                return ['&', '__band__', 'band'];
            case '|':
                return ['|', '__bor__', 'bor'];
            case '^':
                return ['^', '__bxor__', 'bxor'];
            case '&&':
                return ['&&', '__and__', 'and'];
            case '||':
                return ['||', '__or__', 'or'];
            case '!':
                return ['!', '__not__', 'not'];
            case '~':
                return ['~', '__bnot__', 'bnot'];
            case '++':
                return ['++', '__inc__', 'inc'];
            case '--':
                return ['--', '__dec__', 'dec'];
            case '[]':
                return ['[]', '__index__'];
            case '[]=':
                return ['[]=', '__index_set__'];
            case '[-]':
                return ['[-]', '__reverse_index__'];
            case '[-]=':
                return ['[-]=', '__reverse_index_set__'];
            case '()':
                return ['()', '__call__'];
            default:
                return [operator];
        }
    }

    /**
     * Emit a callMethod for an operator overload and return the result.
     */
    private emitOperatorCall(
        obj: ExpressionResult,
        methodId: number,
        returnTd: TypeDescription,
        argRegs: VReg[],
        argTypes: IRType[]
    ): ExpressionResult {
        const f = this.func();
        const retType = this.convertTypeDescriptionToIR(returnTd);
        const retTypes = retType.tag === 'void' ? [] : [retType];
        const dests = retType.tag === 'void' ? [] : [this.tmp()];

        f.callMethod(dests, obj.register, methodId, argRegs, argTypes, retTypes);

        if (dests.length > 0) {
            return { register: dests[0], type: retTypes[0] };
        }
        return { register: this.tmp(), type: voidType() };
    }

    // ============================================================================
    // Context Management
    // ============================================================================

    private createContext(): GenerationContext {
        return {
            currentFunction: null,
            variables: new Map(),
            tempCounter: 0,
            labelCounter: 0,
            loopStack: [],
            scopeDepth: 0,
            scopeVarStack: []
        };
    }

    private tmp(): VReg {
        return `%t${this.context.tempCounter++}`;
    }

    private generateLabel(prefix: string): string {
        return `${prefix}_${this.context.labelCounter++}`;
    }

    private allocateVariable(name: string, type: IRType): VReg {
        const varReg: VReg = `%${name}_${this.context.scopeDepth}`;
        this.context.variables.set(name, { register: varReg, type });
        // Track in current scope for cleanup
        const currentScope = this.context.scopeVarStack[this.context.scopeVarStack.length - 1];
        if (currentScope) {
            currentScope.push(name);
        }
        return varReg;
    }

    private lookupVariable(name: string): { register: VReg; type: IRType } | undefined {
        return this.context.variables.get(name);
    }

    private enterScope(): void {
        this.context.scopeDepth++;
        this.context.scopeVarStack.push([]);
    }

    private exitScope(): void {
        const scopeVars = this.context.scopeVarStack.pop();
        if (scopeVars) {
            for (const name of scopeVars) {
                this.context.variables.delete(name);
            }
        }
        this.context.scopeDepth--;
    }

    private pushLoop(breakLabel: string, continueLabel: string): void {
        this.context.loopStack.push({ breakLabel, continueLabel });
    }

    private popLoop(): void {
        this.context.loopStack.pop();
    }

    private currentLoop(): { breakLabel: string; continueLabel: string } | undefined {
        return this.context.loopStack[this.context.loopStack.length - 1];
    }

    private parseIntegerLiteral(value: string): bigint {
        const cleanValue = value.replace(/[ui](8|16|32|64)$/, '');
        if (cleanValue.startsWith('0x') || cleanValue.startsWith('0X')) {
            return BigInt(cleanValue);
        } else if (cleanValue.startsWith('0b') || cleanValue.startsWith('0B')) {
            return BigInt(cleanValue);
        } else if (cleanValue.startsWith('0o') || cleanValue.startsWith('0O')) {
            return BigInt(cleanValue);
        } else {
            return BigInt(cleanValue);
        }
    }

    private getReferenceName(ref: ast.IdentifiableReference | undefined): string {
        if (!ref) throw new Error("Invalid ref");
        if ('name' in ref && typeof ref.name === 'string') {
            return ref.name;
        }
        if (ast.isClassMethod(ref) && ref.method) {
            return ref.method.names?.[0];
        }
        // Interface method references resolve to MethodHeader directly
        if (ast.isMethodHeader(ref)) {
            return ref.names?.[0];
        }
        // Impl block method references
        if (ast.isImplementationMethodDecl(ref) && ref.method) {
            return ref.method.names?.[0];
        }
        throw new Error("Ref has no name attribute!");
    }

    private assert(condition: boolean, message: string): void {
        if (!condition) {
            throw new Error("Assertion failed: " + message);
        }
    }

    private makeClassKey(
        classDecl: ast.TypeDeclaration,
        substitutions: Map<string, TypeDescription>
    ): string {
        if (substitutions.size === 0) {
            return classDecl.name;
        }
        const typeArgStrings = classDecl.genericParameters
            .map(param => {
                const type = substitutions.get(param.name);
                return type ? type.toString() : param.name;
            });
        return `${classDecl.name}<${typeArgStrings.join(',')}>`;
    }

    /**
     * Check if a variable reference is global
     */
    private isGlobalVar(ref: AstNode): boolean {
        if (ast.isVariableDeclSingle(ref)) {
            const container = ref.$container?.$container?.$container;
            return ast.isModule(container) || ast.isNamespaceDecl(container);
        }
        return false;
    }

    // ============================================================================
    // Public API
    // ============================================================================

    public generate(documents: LangiumDocument<AstNode>[]): IRProgram {
        for (const doc of documents) {
            if (!ast.isModule(doc.parseResult.value)) {
                console.log("Invalid node");
                continue;
            }
            this.visitModule(doc.parseResult.value);
        }

        // Finalize the global init function
        // If a "main" function exists, call it and use its return as exit code
        const mainFunc = this.program.functions.find(f => f.name === 'main');
        if (mainFunc && mainFunc.returnTypes.length > 0) {
            const exitReg = `%$G_exit`;
            this.globalFunc.call([exitReg], 'main', [], [], mainFunc.returnTypes);
            this.globalFunc.exit(exitReg);
        } else if (mainFunc) {
            // main returns void — exit with 0
            const exitReg = `%$G_exit`;
            this.globalFunc.constInt(exitReg, 0, 'u32');
            this.globalFunc.call([], 'main', [], [], []);
            this.globalFunc.exit(exitReg);
        } else {
            // No main — just exit 0
            const exitReg = `%$G_exit`;
            this.globalFunc.constInt(exitReg, 0, 'u32');
            this.globalFunc.exit(exitReg);
        }
        this.program.addFunction(this.globalFunc);
        this.program.entryFunction = '$G';
        this.program.numMethodNames = this.methodNameIdCounter;

        return this.program;
    }

    // ============================================================================
    // Module & Program Level
    // ============================================================================

    private visitModule(node: ast.Module | ast.NamespaceDecl): void {
        this.generateFFILoads(node);

        for (const n of node.definitions) {
            if (ast.isNamespaceDecl(n)) {
                this.visitModule(n);
            }
        }
        this.generateGlobalSymbols(node);
        this.generateClasses(node);
        this.generateFunctions(node);
    }

    private generateFFILoads(node: ast.Module | ast.NamespaceDecl): void {
        const ffiDecls = AstUtils.streamAllContents(node).filter(ast.isExternFFIDecl).toArray();
        for (const decl of ffiDecls) {
            const libname = decl.dynlib;
            if (this.ffiRegistery.has(libname)) continue;
            const id = this.ffiRegistery.register(libname);
            // ffiRegister takes dest (handle register) and libName
            const handleReg = `%ffi_${id}`;
            this.globalFunc.ffiRegister(handleReg, libname);
        }
    }

    private generateGlobalSymbols(node: ast.Module | ast.NamespaceDecl): void {
        const globals = AstUtils.streamContents(node).filter(ast.isVariableDeclarationStatement);
        for (const gvar of globals) {
            for (const variable of gvar.declarations.variables) {
                if (ast.isVariableDeclSingle(variable)) {
                    this.assert(variable.initializer != undefined, `No initializer for variable ${variable.name}`);

                    const varType = this.getNodeIRType(variable);
                    const globalId = this.G(variable);

                    // Declare global in program metadata
                    this.program.declareGlobal({ id: globalId, type: varType });

                    // Generate initializer in global func
                    const prevFunc = this.context.currentFunction;
                    this.context.currentFunction = this.globalFunc;

                    const exprResult = this.visitExpression(variable.initializer!, undefined);
                    this.globalFunc.globalStore(globalId, exprResult.register, exprResult.type);

                    this.context.currentFunction = prevFunc;
                } else if (ast.isVariableDeclTupleDestructuring(variable) && variable.initializer) {
                    // Tuple destructuring in globals: each element becomes a separate global
                    const initTd = this.getType(variable.initializer);
                    const elementTypes: IRType[] = [];
                    if (isTupleType(initTd)) {
                        for (const elemTd of initTd.elementTypes) {
                            elementTypes.push(this.convertTypeDescriptionToIR(elemTd));
                        }
                    }

                    // Declare globals for each element
                    for (let i = 0; i < variable.elements.length; i++) {
                        const elem = variable.elements[i];
                        if (elem.name) {
                            const varType = i < elementTypes.length ? elementTypes[i] : voidType();
                            const globalId = this.globalVariablesRegistry.G(variable, elem.name);
                            this.program.declareGlobal({ id: globalId, type: varType });
                        }
                    }

                    // Generate initializer in global func
                    const prevFunc = this.context.currentFunction;
                    this.context.currentFunction = this.globalFunc;

                    // Evaluate tuple-returning expression
                    const result = this.visitExpression(variable.initializer, undefined);
                    // For a single-value fallback, store to first element
                    if (variable.elements.length > 0 && variable.elements[0].name) {
                        const globalId = this.globalVariablesRegistry.G(variable, variable.elements[0].name);
                        const varType = elementTypes.length > 0 ? elementTypes[0] : result.type;
                        this.globalFunc.globalStore(globalId, result.register, varType);
                    }

                    this.context.currentFunction = prevFunc;
                }
            }
        }
    }

    // ============================================================================
    // Class Generation
    // ============================================================================

    private generateClasses(node: ast.Module | ast.NamespaceDecl): void {
        const classes = AstUtils.streamContents(node)
            .filter(n => ast.isTypeDeclaration(n) && ast.isClassType(n.definition))
            .map(e => e as ast.TypeDeclaration);

        for (const classDecl of classes) {
            if (classDecl.genericParameters.length > 0) {
                this.generateGenericClassInstantiations(classDecl);
            } else {
                const classType = classDecl.definition as ast.ClassType;
                this.generateClass(classDecl, classType);
            }
        }
    }

    private generateGenericClassInstantiations(classDecl: ast.TypeDeclaration): void {
        const allInstantiations = this.monoMorph.getAllClassInstantiations();
        const classInstantiations = allInstantiations.filter(
            inst => inst.declaration === classDecl
        );

        for (const instantiation of classInstantiations) {
            const substitutions = new Map<string, TypeDescription>();
            classDecl.genericParameters.forEach((param, index) => {
                if (index < instantiation.typeArgs.length) {
                    substitutions.set(param.name, instantiation.typeArgs[index]);
                }
            });

            this.pushSubstitutions(substitutions);
            try {
                const classType = classDecl.definition as ast.ClassType;
                this.generateClass(classDecl, classType);
            } finally {
                this.popSubstitutions();
            }
        }
    }

    private generateClass(
        classDecl: ast.TypeDeclaration,
        classType: ast.ClassType
    ): void {
        const substitutions = this.getCurrentSubstitutions();
        const className = substitutions.size > 0
            ? this.monoMorph.mangleName(this.makeClassKey(classDecl, substitutions))
            : classDecl.name;

        this.debugIR(`Generating class: ${className}`);

        // Record class name for direct dispatch at call sites
        this.classNodeToIRName.set(classDecl, className);

        // Declare class shape in program metadata
        const classTd = this.getType(classDecl) as ClassTypeDescription;
        const classFields: ClassFieldShape[] = classTd.attributes.map((attr, idx) => ({
            localFieldId: idx,
            type: this.convertTypeDescriptionToIR(attr.type),
            name: attr.name
        }));

        const classMethods: ClassMethodShape[] = [];
        let methodIdx = 0;
        for (const method of classTd.methods) {
            // Generic methods are monomorphized per call site and do not have a
            // single dispatchable target for vtable slots.
            if (method.genericParameters.length > 0) {
                continue;
            }

            const primaryName = method.names[0] || `method_${methodIdx}`;
            classMethods.push({
                methodId: this.getOrCreateMethodNameId(primaryName),
                name: primaryName,
                funcName: this.monoMorph.mangleName(`${className}::${primaryName}`)
            });
            methodIdx++;
        }

        const classShapeId = `class_${className}`;
        const classUid = this.getOrCreateClassUid(className);
        this.program.declareClass({
            id: classShapeId,
            uid: classUid,
            fields: classFields,
            methods: classMethods,
            implementedInterfaces: classTd.implementations.map(() => 'impl') // Placeholder
        });

        // Generate class-level methods
        for (const method of classType.methods) {
            if (method.method) {
                this.generateMethod(className, method);
            }
        }

        // Generate monomorphized versions of generic methods
        this.generateGenericMethodInstantiations(classDecl, className);

        // Generate methods from implementation blocks
        // Implementation methods are stored separately in classType.implementations
        // and must be generated unless shadowed by an override in the class itself
        this.generateImplMethods(className, classType);
    }

    /**
     * Generate monomorphized versions of generic methods in a class.
     * For each registered instantiation of a generic method, compiles a specialized version.
     */
    private generateGenericMethodInstantiations(
        classDecl: ast.TypeDeclaration,
        className: string
    ): void {
        const classKey = className;
        const methodInstantiations = this.monoMorph.getMethodInstantiations(classKey);

        // Also check with the declaration name for non-generic classes
        // (the classKey in the registry uses the declaration name)
        let allInstantiations = methodInstantiations;
        if (classDecl.name !== className) {
            const extraInstantiations = this.monoMorph.getMethodInstantiations(classDecl.name);
            allInstantiations = [...methodInstantiations, ...extraInstantiations];
        }

        for (const instantiation of allInstantiations) {
            const methodDecl = instantiation.methodDeclaration;

            // Find the ClassMethod AST node that contains this MethodHeader
            const classType = classDecl.definition as ast.ClassType;
            const classMethod = classType.methods.find(m => m.method === methodDecl);
            if (!classMethod || !classMethod.method) continue;

            const methodHeader = classMethod.method;
            if (!methodHeader.genericParameters || methodHeader.genericParameters.length === 0) continue;

            // Build substitutions for the method's generic parameters
            const substitutions = new Map<string, TypeDescription>();
            methodHeader.genericParameters.forEach((param, index) => {
                if (index < instantiation.methodTypeArgs.length) {
                    substitutions.set(param.name, instantiation.methodTypeArgs[index]);
                }
            });

            // Get the mangled name for this instantiation
            const funcName = this.callableRegistry.getGenericMethodName(
                classKey,
                methodHeader,
                instantiation.methodTypeArgs,
                classDecl
            );

            this.debugIR(`  Generating generic method instantiation: ${funcName}`);

            this.pushSubstitutions(substitutions);
            try {
                this.generateMethodWithName(className, classMethod, funcName);
            } finally {
                this.popSubstitutions();
            }
        }
    }

    /**
     * Generate methods from impl blocks attached to a class.
     * Skips methods that are overridden by the class (isOverride: true).
     */
    private generateImplMethods(
        className: string,
        classType: ast.ClassType
    ): void {
        if (!classType.implementations || classType.implementations.length === 0) return;

        // Collect override method names from the class for shadowing check
        const overrideNames = new Set<string>();
        for (const classMethod of classType.methods) {
            if (classMethod.isOverride && classMethod.method) {
                for (const name of classMethod.method.names) {
                    overrideNames.add(name);
                }
            }
        }

        for (const implDecl of classType.implementations) {
            // Resolve the impl type reference to get the ImplementationType AST node
            const implTypeRef = implDecl.type;
            const refTarget = implTypeRef.field?.ref;

            if (!refTarget || !ast.isTypeDeclaration(refTarget)) continue;
            const implDef = refTarget.definition;
            if (!ast.isImplementationType(implDef)) continue;

            // Generate each method from the impl that isn't shadowed
            for (const implMethod of implDef.methods) {
                if (!implMethod.method) continue;

                // Check if any name of this impl method is overridden
                const isShadowed = implMethod.method.names.some(
                    name => overrideNames.has(name)
                );
                if (isShadowed) continue;

                this.generateMethod(className, implMethod);
            }
        }
    }

    private generateMethod(
        className: string,
        classMethod: ast.ClassMethod
    ): void {
        if (!classMethod.method) return;
        const methodHeader = classMethod.method;

        // Skip generic methods — they are monomorphized and generated
        // separately for each concrete instantiation at call sites
        if (methodHeader.genericParameters && methodHeader.genericParameters.length > 0) {
            return;
        }

        const fullMethodName = this.callableRegistry.getMethodNameForClass(
            className,
            methodHeader
        );

        this.debugIR(`  Generating method: ${fullMethodName}`);

        // Build params: implicit 'this' + user params
        const params: FunctionParam[] = [
            { name: 'this', type: ptrType('class') }
        ];
        for (const param of methodHeader.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            params.push({ name: param.name, type: paramType });
        }

        // Return types
        const returnTypes: IRType[] = [];
        if (methodHeader.header.returnType) {
            returnTypes.push(this.convertTypeWithSubstitution(methodHeader.header.returnType));
        }

        const lirFunc = this.program.createFunction(
            fullMethodName, params, returnTypes
        );

        // Save and set context
        const prevFunction = this.context.currentFunction;
        const prevVars = new Map(this.context.variables);
        const prevTemp = this.context.tempCounter;
        const prevLabel = this.context.labelCounter;
        const prevScope = this.context.scopeDepth;

        this.context.currentFunction = lirFunc;
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map 'this' parameter
        this.context.variables.set('this', { register: 'this', type: ptrType('class') });

        // Map user parameters
        for (const param of methodHeader.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            this.context.variables.set(param.name, { register: param.name, type: paramType });
        }

        // Generate body
        if (classMethod.body) {
            this.visitBlockStatement(classMethod.body);
        } else if (classMethod.expr) {
            const result = this.visitExpression(classMethod.expr, undefined);
            lirFunc.ret([result.register], [result.type]);
        }

        // Ensure function ends with a return (implicit void return)
        const lastInst = lirFunc.instructions[lirFunc.instructions.length - 1];
        if (!lastInst || (lastInst.kind !== 'ret' && lastInst.kind !== 'exit')) {
            lirFunc.ret();
        }

        this.debugIRFunction(lirFunc);

        // Restore context
        this.context.currentFunction = prevFunction;
        this.context.variables = prevVars;
        this.context.tempCounter = prevTemp;
        this.context.labelCounter = prevLabel;
        this.context.scopeDepth = prevScope;
    }

    /**
     * Generate a method with an explicit mangled name.
     * Used for monomorphized generic method instantiations.
     */
    private generateMethodWithName(
        className: string,
        classMethod: ast.ClassMethod,
        fullMethodName: string
    ): void {
        if (!classMethod.method) return;
        const methodHeader = classMethod.method;

        // Build params: implicit 'this' + user params
        const params: FunctionParam[] = [
            { name: 'this', type: ptrType('class') }
        ];
        for (const param of methodHeader.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            params.push({ name: param.name, type: paramType });
        }

        // Return types
        const returnTypes: IRType[] = [];
        if (methodHeader.header.returnType) {
            returnTypes.push(this.convertTypeWithSubstitution(methodHeader.header.returnType));
        }

        const lirFunc = this.program.createFunction(
            fullMethodName, params, returnTypes
        );

        // Save and set context
        const prevFunction = this.context.currentFunction;
        const prevVars = new Map(this.context.variables);
        const prevTemp = this.context.tempCounter;
        const prevLabel = this.context.labelCounter;
        const prevScope = this.context.scopeDepth;

        this.context.currentFunction = lirFunc;
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map 'this' parameter
        this.context.variables.set('this', { register: 'this', type: ptrType('class') });

        // Map user parameters
        for (const param of methodHeader.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            this.context.variables.set(param.name, { register: param.name, type: paramType });
        }

        // Generate body
        if (classMethod.body) {
            this.visitBlockStatement(classMethod.body);
        } else if (classMethod.expr) {
            const result = this.visitExpression(classMethod.expr, undefined);
            lirFunc.ret([result.register], [result.type]);
        }

        // Ensure function ends with a return (implicit void return)
        const lastInst = lirFunc.instructions[lirFunc.instructions.length - 1];
        if (!lastInst || (lastInst.kind !== 'ret' && lastInst.kind !== 'exit')) {
            lirFunc.ret();
        }

        this.debugIRFunction(lirFunc);

        // Restore context
        this.context.currentFunction = prevFunction;
        this.context.variables = prevVars;
        this.context.tempCounter = prevTemp;
        this.context.labelCounter = prevLabel;
        this.context.scopeDepth = prevScope;
    }

    // ============================================================================
    // Function Generation
    // ============================================================================

    private generateFunctions(node: ast.Module | ast.NamespaceDecl): void {
        for (const n of node.definitions) {
            if (ast.isFunctionDeclaration(n)) {
                if (n.genericParameters && n.genericParameters.length > 0) {
                    this.generateGenericFunctionInstantiations(n);
                } else {
                    this.visitFunctionDeclaration(n);
                }
            }
        }
    }

    private generateGenericFunctionInstantiations(funcDecl: ast.FunctionDeclaration): void {
        const allInstantiations = this.monoMorph.getAllFunctionInstantiations();
        const funcInstantiations = allInstantiations.filter(
            inst => inst.declaration === funcDecl
        );

        for (const instantiation of funcInstantiations) {
            const substitutions = new Map<string, TypeDescription>();
            funcDecl.genericParameters.forEach((param: ast.GenericType, index: number) => {
                if (index < instantiation.typeArgs.length) {
                    substitutions.set(param.name, instantiation.typeArgs[index]);
                }
            });

            this.pushSubstitutions(substitutions);
            try {
                const funcName = this.callableRegistry.getGenericFunctionName(
                    funcDecl,
                    instantiation.typeArgs
                );
                this.visitFunctionDeclarationWithName(funcDecl, funcName);
            } finally {
                this.popSubstitutions();
            }
        }
    }

    private visitFunctionDeclaration(node: ast.FunctionDeclaration): void {
        const funcName = this.C(node);
        this.visitFunctionDeclarationWithName(node, funcName);
    }

    private visitFunctionDeclarationWithName(node: ast.FunctionDeclaration, funcName: string): void {
        // Build params
        const params: FunctionParam[] = node.header.args.map(param => ({
            name: param.name,
            type: param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType()
        }));

        // Return types
        const returnTypes: IRType[] = [];
        if (node.header.returnType) {
            const retTd = this.getType(node.header.returnType);
            if (isTupleType(retTd)) {
                for (const elem of retTd.elementTypes) {
                    returnTypes.push(this.convertTypeDescriptionToIR(elem));
                }
            } else {
                returnTypes.push(this.convertTypeDescriptionToIR(retTd));
            }
        }

        const isCoroutine = node.fnType === 'cfn';
        const lirFunc = this.program.createFunction(
            funcName, params, returnTypes,
            { isCoroutine }
        );

        // Save and set context
        const prevFunction = this.context.currentFunction;
        const prevVars = new Map(this.context.variables);
        const prevTemp = this.context.tempCounter;
        const prevLabel = this.context.labelCounter;
        const prevScope = this.context.scopeDepth;

        this.context.currentFunction = lirFunc;
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map parameters to registers
        for (const param of node.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            this.context.variables.set(param.name, { register: param.name, type: paramType });
        }

        // Generate body
        if (node.body) {
            this.visitBlockStatement(node.body);
        } else if (node.expr) {
            const result = this.visitExpression(node.expr, undefined);
            lirFunc.ret([result.register], [result.type]);
        }

        // Ensure function ends with a return (implicit void return)
        const lastInst = lirFunc.instructions[lirFunc.instructions.length - 1];
        if (!lastInst || (lastInst.kind !== 'ret' && lastInst.kind !== 'exit')) {
            lirFunc.ret();
        }

        this.debugIRFunction(lirFunc);

        // Restore context
        this.context.currentFunction = prevFunction;
        this.context.variables = prevVars;
        this.context.tempCounter = prevTemp;
        this.context.labelCounter = prevLabel;
        this.context.scopeDepth = prevScope;
    }

    // ============================================================================
    // Statements
    // ============================================================================

    private visitBlockStatement(node: ast.BlockStatement): void {
        this.enterScope();
        for (const stmt of node.statements) {
            this.visitStatement(stmt);
        }
        this.exitScope();
    }

    private visitStatement(node: ast.Statement): void {
        if (ast.isExpressionStatement(node)) {
            this.visitExpression(node.expr, undefined);
        } else if (ast.isVariableDeclarationStatement(node)) {
            this.visitLocalVariableDeclaration(node);
        } else if (ast.isReturnStatement(node)) {
            this.visitReturnStatement(node);
        } else if (ast.isIfStatement(node)) {
            this.visitIfStatement(node);
        } else if (ast.isWhileStatement(node)) {
            this.visitWhileStatement(node);
        } else if (ast.isDoWhileStatement(node)) {
            this.visitDoWhileStatement(node);
        } else if (ast.isForStatement(node)) {
            this.visitForStatement(node);
        } else if (ast.isForeachStatement(node)) {
            this.visitForeachStatement(node);
        } else if (ast.isMatchStatement(node)) {
            this.visitMatchStatement(node);
        } else if (ast.isBreakStatement(node)) {
            this.visitBreakStatement();
        } else if (ast.isContinueStatement(node)) {
            this.visitContinueStatement();
        } else if (ast.isBlockStatement(node)) {
            this.visitBlockStatement(node);
        } else if (ast.isFunctionDeclarationStatement(node)) {
            this.visitFunctionDeclaration(node.fn);
        }
    }

    // ---- Variable Declaration ----

    private visitLocalVariableDeclaration(node: ast.VariableDeclarationStatement): void {
        for (const varDecl of node.declarations.variables) {
            if (ast.isVariableDeclSingle(varDecl) && varDecl.initializer) {
                const result = this.visitExpression(varDecl.initializer, undefined);
                const varType = this.getNodeIRType(varDecl);
                const varReg = this.allocateVariable(varDecl.name, varType);
                this.func().mov(varReg, result.register, varType);
            } else if (ast.isVariableDeclTupleDestructuring(varDecl) && varDecl.initializer) {
                this.visitTupleDestructuring(varDecl);
            }
        }
    }

    /**
     * Handle tuple destructuring: let (x, y) = someCall()
     * Tuples in Type-C are only for function returns, so the initializer
     * should be a function call that returns multiple values.
     */
    private visitTupleDestructuring(varDecl: ast.VariableDeclTupleDestructuring): void {
        const f = this.func();
        const elements = varDecl.elements;

        // Get the type of the initializer — should be a TupleType
        const initTd = this.getType(varDecl.initializer!);

        // Determine element types from the tuple type
        const elementTypes: IRType[] = [];
        if (isTupleType(initTd)) {
            for (const elemTd of initTd.elementTypes) {
                elementTypes.push(this.convertTypeDescriptionToIR(elemTd));
            }
        } else {
            // Not a tuple type — fall back to evaluating as single value
            const result = this.visitExpression(varDecl.initializer!, undefined);
            if (elements.length > 0 && elements[0].name) {
                const varReg = this.allocateVariable(elements[0].name, result.type);
                f.mov(varReg, result.register, result.type);
            }
            return;
        }

        // Generate the function call with multiple dest registers
        const init = varDecl.initializer!;
        if (ast.isFunctionCall(init)) {
            // Direct call: generate with multiple dests
            const dests: VReg[] = elements.map(() => this.tmp());
            const retTypes = elementTypes;

            // Evaluate arguments
            const argRegs: VReg[] = [];
            const argTypes: IRType[] = [];
            if (init.args) {
                for (const arg of init.args) {
                    const argResult = this.visitExpression(arg, undefined);
                    argRegs.push(argResult.register);
                    argTypes.push(argResult.type);
                }
            }

            // Determine call target
            if (ast.isMemberAccess(init.expr)) {
                const memberAccess = init.expr;
                const obj = this.visitExpression(memberAccess.expr, undefined);
                const memberRef = memberAccess.element?.ref;
                const objTd = this.getType(memberAccess.expr);
                const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;

                if (isClassType(resolvedObjTd) && memberRef) {
                    // Concrete class — direct call
                    const methodName = this.getReferenceName(memberRef);
                    const classNode = resolvedObjTd.node;
                    const className = classNode && ast.isTypeDeclaration(classNode)
                        ? this.classNodeToIRName.get(classNode) || classNode.name
                        : undefined;
                    if (className) {
                        const funcName = this.monoMorph.mangleName(`${className}::${methodName}`);
                        f.call(dests, funcName, [obj.register, ...argRegs], [obj.type, ...argTypes], retTypes);
                    } else {
                        const methodId = this.getMethodId(resolvedObjTd, methodName);
                        f.callMethod(dests, obj.register, methodId, argRegs, argTypes, retTypes);
                    }
                } else if (isInterfaceType(resolvedObjTd) && memberRef) {
                    // Interface — vtable dispatch
                    const methodName = this.getReferenceName(memberRef);
                    const methodId = this.getMethodId(resolvedObjTd, methodName);
                    f.callMethod(dests, obj.register, methodId, argRegs, argTypes, retTypes);
                } else {
                    f.call(dests, 'unknown', argRegs, argTypes, retTypes);
                }
            } else if (ast.isQualifiedReference(init.expr)) {
                const ref = init.expr.reference?.ref;
                if (ref && ast.isFunctionDeclaration(ref)) {
                    const funcName = this.C(ref);
                    f.call(dests, funcName, argRegs, argTypes, retTypes);
                } else {
                    const varInfo = this.lookupVariable(this.getReferenceName(ref));
                    if (varInfo && varInfo.type.tag === 'ptr' && varInfo.type.kind === 'closure') {
                        f.callClosure(dests, varInfo.register, argRegs, argTypes, retTypes);
                    } else {
                        f.call(dests, 'unknown', argRegs, argTypes, retTypes);
                    }
                }
            } else {
                const funcExpr = this.visitExpression(init.expr, undefined);
                if (funcExpr.type.tag === 'ptr' && funcExpr.type.kind === 'closure') {
                    f.callClosure(dests, funcExpr.register, argRegs, argTypes, retTypes);
                } else {
                    f.call(dests, funcExpr.register, argRegs, argTypes, retTypes);
                }
            }

            // Map each dest register to the corresponding variable
            for (let i = 0; i < elements.length && i < dests.length; i++) {
                const elem = elements[i];
                if (elem.name) {
                    const varType = i < elementTypes.length ? elementTypes[i] : voidType();
                    const varReg = this.allocateVariable(elem.name, varType);
                    f.mov(varReg, dests[i], varType);
                }
            }
        } else {
            // Initializer is not a function call — evaluate and try to unpack
            // (This shouldn't normally happen since tuples are only for returns)
            const result = this.visitExpression(init, undefined);
            if (elements.length > 0 && elements[0].name) {
                const varType = elementTypes.length > 0 ? elementTypes[0] : result.type;
                const varReg = this.allocateVariable(elements[0].name, varType);
                f.mov(varReg, result.register, varType);
            }
        }
    }

    // ---- Return ----

    private visitReturnStatement(node: ast.ReturnStatement): void {
        if (node.expr) {
            const result = this.visitExpression(node.expr, undefined);
            // Check if returning a tuple expression
            if (ast.isTupleExpression(node.expr) && node.expr.expressions.length > 1) {
                // Multi-value return handled in visitTupleExpression
                // result is the first value; we need all values
                const values: VReg[] = [];
                const types: IRType[] = [];
                for (const elem of node.expr.expressions) {
                    const r = this.visitExpression(elem, undefined);
                    values.push(r.register);
                    types.push(r.type);
                }
                this.func().ret(values, types);
            } else {
                this.func().ret([result.register], [result.type]);
            }
        } else {
            this.func().ret();
        }
    }

    // ---- Control Flow Statements ----

    private visitIfStatement(node: ast.IfStatement): void {
        const f = this.func();
        const condition = this.visitExpression(node.condition, undefined);
        const thenLabel = this.generateLabel('then');
        const elseLabel = this.generateLabel('else');
        const endLabel = this.generateLabel('endif');

        f.br(condition.register, thenLabel, elseLabel);

        f.label(thenLabel);
        this.visitBlockStatement(node.body);
        f.jmp(endLabel);

        f.label(elseLabel);
        if (node.elseBody) {
            this.visitBlockStatement(node.elseBody);
        } else if (node.elseIf && node.elseIf.length > 0) {
            for (const elseIf of node.elseIf) {
                this.visitIfStatement(elseIf);
            }
        }
        f.jmp(endLabel);

        f.label(endLabel);
    }

    private visitWhileStatement(node: ast.WhileStatement): void {
        const f = this.func();
        const loopStart = this.generateLabel('while_start');
        const loopBody = this.generateLabel('while_body');
        const loopEnd = this.generateLabel('while_end');

        this.pushLoop(loopEnd, loopStart);

        f.label(loopStart);
        const condition = this.visitExpression(node.condition, undefined);
        f.br(condition.register, loopBody, loopEnd);

        f.label(loopBody);
        this.visitBlockStatement(node.body);
        f.jmp(loopStart);

        f.label(loopEnd);
        this.popLoop();
    }

    private visitDoWhileStatement(node: ast.DoWhileStatement): void {
        const f = this.func();
        const loopStart = this.generateLabel('do_start');
        const loopCheck = this.generateLabel('do_check');
        const loopEnd = this.generateLabel('do_end');

        this.pushLoop(loopEnd, loopCheck);

        f.label(loopStart);
        this.visitBlockStatement(node.body);

        f.label(loopCheck);
        const condition = this.visitExpression(node.condition, undefined);
        f.br(condition.register, loopStart, loopEnd);

        f.label(loopEnd);
        this.popLoop();
    }

    private visitForStatement(node: ast.ForStatement): void {
        // Try the optimized FORI/FORL path for simple numeric loops
        if (this.tryEmitFORILoop(node)) {
            return;
        }

        // Fall back to generic path
        const f = this.func();
        const loopStart = this.generateLabel('for_start');
        const loopBody = this.generateLabel('for_body');
        const loopUpdate = this.generateLabel('for_update');
        const loopEnd = this.generateLabel('for_end');

        this.pushLoop(loopEnd, loopUpdate);
        this.enterScope();

        if (node.init) {
            this.visitStatement(node.init);
        }

        f.label(loopStart);
        if (node.condition) {
            const condition = this.visitExpression(node.condition, undefined);
            f.br(condition.register, loopBody, loopEnd);
        } else {
            f.jmp(loopBody);
        }

        f.label(loopBody);
        this.visitBlockStatement(node.body);

        f.label(loopUpdate);
        if (node.update) {
            this.visitExpression(node.update, undefined);
        }
        f.jmp(loopStart);

        f.label(loopEnd);
        this.exitScope();
        this.popLoop();
    }

    /**
     * Try to emit optimized FORI/FORL instructions for a numeric for-loop.
     * Pattern: for let i: <int> = <init>; i < <limit>; i = i + <step> { body }
     *
     * Returns true if the optimized path was taken, false to fall back to generic.
     */
    private tryEmitFORILoop(node: ast.ForStatement): boolean {
        // All three parts must be present
        if (!node.init || !node.condition || !node.update) return false;

        // 1. Init must be a single variable declaration with initializer
        if (!ast.isVariableDeclarationStatement(node.init)) return false;
        const initStmt = node.init;
        if (initStmt.declarations.variables.length !== 1) return false;
        const varDecl = initStmt.declarations.variables[0];
        if (!ast.isVariableDeclSingle(varDecl) || !varDecl.initializer) return false;

        // Variable must be integer type
        const varIRType = this.getNodeIRType(varDecl);
        if (!isInteger(varIRType)) return false;

        // 2. Condition must be: loopVar < expr
        if (!ast.isBinaryExpression(node.condition)) return false;
        if (node.condition.op !== '<') return false;
        if (!ast.isQualifiedReference(node.condition.left)) return false;
        if (node.condition.left.reference?.ref !== varDecl) return false;

        // 3. Update must be: loopVar = loopVar + step  OR  loopVar += step
        if (!ast.isBinaryExpression(node.update)) return false;
        let stepExpr: ast.Expression | undefined;

        if (node.update.op === '=') {
            // Pattern: i = i + step
            if (!ast.isQualifiedReference(node.update.left)) return false;
            if (node.update.left.reference?.ref !== varDecl) return false;
            if (!ast.isBinaryExpression(node.update.right)) return false;
            if (node.update.right.op !== '+') return false;
            if (!ast.isQualifiedReference(node.update.right.left)) return false;
            if (node.update.right.left.reference?.ref !== varDecl) return false;
            stepExpr = node.update.right.right;
        } else if (node.update.op === '+=') {
            // Pattern: i += step
            if (!ast.isQualifiedReference(node.update.left)) return false;
            if (node.update.left.reference?.ref !== varDecl) return false;
            stepExpr = node.update.right;
        } else {
            return false;
        }

        // 4. Loop variable must not be modified inside body
        if (this.isVarModifiedInBody(varDecl, node.body)) return false;

        // === All checks passed: emit FORI/FORL ===
        const f = this.func();
        this.enterScope();

        const exitLabel = this.generateLabel('fori_exit');
        const bodyLabel = this.generateLabel('fori_body');
        const updateLabel = this.generateLabel('fori_update');

        // break → exitLabel (after FORL), continue → updateLabel (before FORL)
        this.pushLoop(exitLabel, updateLabel);

        // Evaluate init, limit, step expressions
        const initResult = this.visitExpression(varDecl.initializer, undefined);
        const limitResult = this.visitExpression(node.condition.right, undefined);
        const stepResult = this.visitExpression(stepExpr!, undefined);

        // Allocate the loop variable (base register for FORI/FORL)
        const baseReg = this.allocateVariable(varDecl.name, varIRType);

        // forInit: sets base=init, checks condition, jumps to exit if iter >= limit
        f.forInit(baseReg, initResult.register, limitResult.register,
                  stepResult.register, exitLabel);

        // Body
        f.label(bodyLabel);
        this.visitBlockStatement(node.body);

        // Update point (continue target) + FORL
        f.label(updateLabel);
        // forLoop's label is the backward jump target (bodyLabel):
        // FORL increments iter, then jumps backward to bodyLabel if iter < limit,
        // otherwise falls through to exitLabel
        f.forLoop(baseReg, bodyLabel);

        // Exit
        f.label(exitLabel);
        this.exitScope();
        this.popLoop();

        return true;
    }

    /**
     * Check if a variable is modified (assigned or postfix-operated) anywhere in a block.
     * Used to guard FORI/FORL optimization — if the loop variable is modified in the body,
     * we must fall back to the generic loop path.
     */
    private isVarModifiedInBody(
        varDecl: ast.VariableDeclSingle,
        body: ast.BlockStatement
    ): boolean {
        for (const node of AstUtils.streamAllContents(body)) {
            // Check assignment expressions (=, +=, -=, etc.)
            if (ast.isBinaryExpression(node)) {
                const op = node.op;
                if (op === '=' || op === '+=' || op === '-=' || op === '*=' ||
                    op === '/=' || op === '%=' || op === '<<=' || op === '>>=' ||
                    op === '&=' || op === '|=' || op === '^=') {
                    if (ast.isQualifiedReference(node.left) &&
                        node.left.reference?.ref === varDecl) {
                        return true;
                    }
                }
            }
            // Check postfix operations (i++, i--)
            if (ast.isPostfixOp(node)) {
                if (ast.isQualifiedReference(node.expr) &&
                    node.expr.reference?.ref === varDecl) {
                    return true;
                }
            }
        }
        return false;
    }

    private visitForeachStatement(node: ast.ForeachStatement): void {
        const f = this.func();
        this.enterScope();

        if (ast.isForEachIterator(node)) {
            // foreach (item in collection)
            const collection = this.visitExpression(node.collection, undefined);
            const lenReg = this.tmp();
            f.arrayLength(lenReg, collection.register);

            const idxReg = this.allocateVariable(`%foreach_idx`, scalarType('u64'));
            f.constInt(idxReg, 0, 'u64');

            const stepReg = this.tmp();
            f.constInt(stepReg, 1, 'u64');

            const loopStart = this.generateLabel('foreach_start');
            const loopBody = this.generateLabel('foreach_body');
            const loopUpdate = this.generateLabel('foreach_update');
            const loopEnd = this.generateLabel('foreach_end');

            // continue should execute the update step before re-checking the condition
            this.pushLoop(loopEnd, loopUpdate);

            f.label(loopStart);
            const cmpReg = this.tmp();
            f.cmpLt(cmpReg, idxReg, lenReg, 'u64');
            f.br(cmpReg, loopBody, loopEnd);

            f.label(loopBody);

            // Get element type from the collection's TypeDescription
            const collTd = this.getType(node.collection);
            let elemIRType: IRType = voidType();
            if (isArrayType(collTd)) {
                elemIRType = this.convertTypeDescriptionToIR(collTd.elementType);
            }

            // Bind loop variable
            const varName = node.valueVar.name ?? '_';
            const elemReg = this.allocateVariable(varName, elemIRType);
            f.arrayGet(elemReg, collection.register, idxReg, elemIRType);

            this.visitBlockStatement(node.body);

            // Increment index
            f.label(loopUpdate);
            f.add(idxReg, idxReg, stepReg, 'u64');
            f.jmp(loopStart);

            f.label(loopEnd);
            this.popLoop();
        } else if (ast.isForRangeIterator(node)) {
            // foreach (i in start..end)
            const startResult = this.visitExpression(node.start, undefined);
            const endResult = this.visitExpression(node.end, undefined);

            const numType = this.extractNumericType(startResult.type, node);

            const stepReg = this.tmp();
            f.constInt(stepReg, 1, numType as IntType);

            const varName = node.valueVar.name ?? '_';
            const iterReg = this.allocateVariable(varName, startResult.type);
            f.mov(iterReg, startResult.register, startResult.type);

            const loopStart = this.generateLabel('forrange_start');
            const loopBody = this.generateLabel('forrange_body');
            const loopUpdate = this.generateLabel('forrange_update');
            const loopEnd = this.generateLabel('forrange_end');

            // continue should execute the update step before re-checking the condition
            this.pushLoop(loopEnd, loopUpdate);

            f.label(loopStart);
            const cmpReg = this.tmp();
            f.cmpLt(cmpReg, iterReg, endResult.register, numType);
            f.br(cmpReg, loopBody, loopEnd);

            f.label(loopBody);
            this.visitBlockStatement(node.body);

            f.label(loopUpdate);
            f.add(iterReg, iterReg, stepReg, numType);
            f.jmp(loopStart);

            f.label(loopEnd);
            this.popLoop();
        }

        this.exitScope();
    }

    private visitBreakStatement(): void {
        const loop = this.currentLoop();
        if (loop) {
            this.func().jmp(loop.breakLabel);
        }
    }

    private visitContinueStatement(): void {
        const loop = this.currentLoop();
        if (loop) {
            this.func().jmp(loop.continueLabel);
        }
    }

    // ============================================================================
    // Expressions
    // ============================================================================

    private visitExpression(node: ast.Expression, varname: string | undefined): ExpressionResult {
        // Literal expressions
        if (ast.isDecimalIntegerLiteral(node) ||
            ast.isHexadecimalIntegerLiteral(node) ||
            ast.isBinaryIntegerLiteral(node) ||
            ast.isOctalIntegerLiteral(node)) {
            return this.visitIntegerLiteral(node);
        }
        if (ast.isFloatLiteral(node) || ast.isDoubleLiteral(node)) {
            return this.visitFloatingPointLiteral(node);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return this.visitBooleanLiteral(node);
        }
        if (ast.isStringLiteralExpression(node)) {
            return this.visitStringLiteral(node);
        }
        if (ast.isNullLiteralExpression(node)) {
            return this.visitNullLiteral();
        }

        // Binary operations
        if (ast.isBinaryExpression(node)) {
            return this.visitBinaryExpression(node);
        }

        // Unary operations
        if (ast.isUnaryExpression(node)) {
            return this.visitUnaryExpression(node);
        }

        // Variable reference
        if (ast.isQualifiedReference(node)) {
            return this.visitQualifiedReference(node);
        }

        // Function call
        if (ast.isFunctionCall(node)) {
            return this.visitFunctionCall(node);
        }

        // Member access
        if (ast.isMemberAccess(node)) {
            return this.visitMemberAccess(node);
        }

        // Index access
        if (ast.isIndexAccess(node)) {
            return this.visitIndexAccess(node);
        }

        // Array construction
        if (ast.isArrayConstructionExpression(node)) {
            return this.visitArrayConstruction(node);
        }

        // Struct construction
        if (ast.isNamedStructConstructionExpression(node) ||
            ast.isAnonymousStructConstructionExpression(node)) {
            return this.visitStructConstruction(node);
        }

        // Control flow expressions
        if (ast.isConditionalExpression(node)) {
            return this.visitConditionalExpression(node);
        }

        if (ast.isMatchExpression(node)) {
            return this.visitMatchExpression(node);
        }

        if (ast.isLetInExpression(node)) {
            return this.visitLetInExpression(node);
        }

        // Special expressions
        if (ast.isThisExpression(node)) {
            return this.visitThisExpression();
        }

        if (ast.isNewExpression(node)) {
            return this.visitNewExpression(node);
        }

        if (ast.isLambdaExpression(node)) {
            return this.visitLambdaExpression(node);
        }

        if (ast.isDoExpression(node)) {
            return this.visitDoExpression(node);
        }

        if (ast.isThrowExpression(node)) {
            return this.visitThrowExpression(node);
        }

        if (ast.isYieldExpression(node)) {
            return this.visitYieldExpression(node);
        }

        if (ast.isCoroutineExpression(node)) {
            return this.visitCoroutineExpression(node);
        }

        if (ast.isTupleExpression(node)) {
            return this.visitTupleExpression(node);
        }

        // Type operations
        if (ast.isInstanceCheckExpression(node)) {
            return this.visitInstanceCheckExpression(node);
        }

        if (ast.isTypeCastExpression(node)) {
            return this.visitTypeCastExpression(node);
        }

        // Postfix operations
        if (ast.isPostfixOp(node)) {
            return this.visitPostfixOp(node);
        }

        // Denull expression
        if (ast.isDenullExpression(node)) {
            return this.visitDenullExpression(node);
        }

        // Index set: arr[i] = value (as expression)
        if (ast.isIndexSet(node)) {
            return this.visitIndexSet(node);
        }

        // Reverse index access: arr[-i]
        if (ast.isReverseIndexAccess(node)) {
            return this.visitReverseIndexAccess(node);
        }

        // Reverse index set: arr[-i] = value
        if (ast.isReverseIndexSet(node)) {
            return this.visitReverseIndexSet(node);
        }

        // Object update: obj.{ field: newValue }
        if (ast.isObjectUpdate(node)) {
            return this.visitObjectUpdate(node);
        }

        // Wildcard expression: _
        if (ast.isWildcardExpression(node)) {
            return this.visitWildcardExpression();
        }

        // Unreachable expression
        if (ast.isUnreachableExpression(node)) {
            return this.visitUnreachableExpression();
        }

        // Mutate expression: mutate expr
        if (ast.isMutateExpression(node)) {
            return this.visitMutateExpression(node);
        }

        // Binary string literal: b"..."
        if (ast.isBinaryStringLiteralExpression(node)) {
            return this.visitBinaryStringLiteral(node);
        }

        // Default: return undef
        const temp = this.tmp();
        const nodeType = this.getNodeIRType(node);
        this.func().undef(temp, nodeType);
        return { register: temp, type: nodeType };
    }

    // ============================================================================
    // Literals
    // ============================================================================

    private visitIntegerLiteral(node: ast.IntegerLiteral): ExpressionResult {
        const temp = this.tmp();
        const value = this.parseIntegerLiteral(node.value);
        const irType = this.getNodeIRType(node);
        const intType = this.extractNumericType(irType, node) as IntType;
        this.func().constInt(temp, value, intType);
        return { register: temp, type: irType };
    }

    private visitFloatingPointLiteral(node: ast.FloatingPointLiteral): ExpressionResult {
        const temp = this.tmp();
        const value = parseFloat(node.value);
        const irType = this.getNodeIRType(node);
        const floatType = (irType.tag === 'scalar' && irType.scalar === 'f64') ? 'f64' : 'f32';
        this.func().constFloat(temp, value, floatType as FloatType);
        return { register: temp, type: irType };
    }

    private visitBooleanLiteral(node: ast.BooleanLiteral): ExpressionResult {
        const temp = this.tmp();
        const value = ast.isTrueBooleanLiteral(node);
        this.func().constBool(temp, value);
        return { register: temp, type: scalarType('bool') };
    }

    private visitStringLiteral(node: ast.StringLiteralExpression): ExpressionResult {
        const temp = this.tmp();
        this.func().strConst(temp, node.value);
        this.program.addStringConstant(node.value);
        return { register: temp, type: ptrType('string') };
    }

    private visitNullLiteral(): ExpressionResult {
        const temp = this.tmp();
        this.func().constNull(temp);
        return { register: temp, type: ptrType('struct') };
    }

    // ============================================================================
    // Binary & Unary Expressions
    // ============================================================================

    private visitBinaryExpression(node: ast.BinaryExpression): ExpressionResult {
        const op = node.op;

        // Assignment operators
        if (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' ||
            op === '%=' || op === '<<=' || op === '>>=' || op === '&=' || op === '|=' || op === '^=') {
            return this.visitAssignmentExpression(node);
        }

        // Null coalescing
        if (op === '??') {
            return this.visitNullCoalescing(node);
        }

        // Logical short-circuit
        if (op === '&&') {
            return this.visitLogicalAnd(node);
        }
        if (op === '||') {
            return this.visitLogicalOr(node);
        }

        // Standard binary: evaluate both sides
        const left = this.visitExpression(node.left, undefined);

        if(left.type.tag === "void") {
            this.visitExpression(node.left, undefined);
        }

        const right = this.visitExpression(node.right, undefined);

        // Check for operator overload on the left operand
        const leftTd = this.getType(node.left);
        const rightTd = this.getType(node.right);
        const overload = this.resolveOperatorMethod(leftTd, op, [rightTd]);
        if (overload) {
            return this.emitOperatorCall(
                left, overload.methodId, overload.returnType,
                [right.register], [right.type]
            );
        }

        const temp = this.tmp();

        // Arithmetic (primitive fallback)
        if (op === '+') {
            if (this.isStringIRType(left.type)) {
                this.func().strConcat(temp, left.register, right.register, right.type);
                return { register: temp, type: ptrType('string') };
            }
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const numType = this.extractNumericType(operandType, node);
            this.func().add(temp, leftValue.register, rightValue.register, numType);
            return { register: temp, type: operandType };
        }
        if (op === '-') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const numType = this.extractNumericType(operandType, node);
            this.func().sub(temp, leftValue.register, rightValue.register, numType);
            return { register: temp, type: operandType };
        }
        if (op === '*') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const numType = this.extractNumericType(operandType, node);
            this.func().mul(temp, leftValue.register, rightValue.register, numType);
            return { register: temp, type: operandType };
        }
        if (op === '/') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const numType = this.extractNumericType(operandType, node);
            this.func().div(temp, leftValue.register, rightValue.register, numType);
            return { register: temp, type: operandType };
        }
        if (op === '%') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const numType = this.extractNumericType(operandType, node);
            this.func().mod(temp, leftValue.register, rightValue.register, numType);
            return { register: temp, type: operandType };
        }

        // Bitwise
        if (op === '<<') {
            this.func().shl(temp, left.register, right.register);
            return { register: temp, type: left.type };
        }
        if (op === '>>') {
            const signed = isSignedInt(left.type);
            this.func().shr(temp, left.register, right.register, signed);
            return { register: temp, type: left.type };
        }
        if (op === '&') {
            this.func().band(temp, left.register, right.register);
            return { register: temp, type: left.type };
        }
        if (op === '|') {
            this.func().bor(temp, left.register, right.register);
            return { register: temp, type: left.type };
        }
        if (op === '^') {
            this.func().bxor(temp, left.register, right.register);
            return { register: temp, type: left.type };
        }

        // Comparison
        const boolType = scalarType('bool');
        if (op === '<') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const cmpType = this.extractNumericType(operandType, node);
            this.func().cmpLt(temp, leftValue.register, rightValue.register, cmpType);
            return { register: temp, type: boolType };
        }
        if (op === '>') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const cmpType = this.extractNumericType(operandType, node);
            this.func().cmpGt(temp, leftValue.register, rightValue.register, cmpType);
            return { register: temp, type: boolType };
        }
        if (op === '<=') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const cmpType = this.extractNumericType(operandType, node);
            this.func().cmpLe(temp, leftValue.register, rightValue.register, cmpType);
            return { register: temp, type: boolType };
        }
        if (op === '>=') {
            const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
            const leftValue = this.coerceScalarExpression(left, operandType);
            const rightValue = this.coerceScalarExpression(right, operandType);
            const cmpType = this.extractNumericType(operandType, node);
            this.func().cmpGe(temp, leftValue.register, rightValue.register, cmpType);
            return { register: temp, type: boolType };
        }
        if (op === '==') {
            if (this.isStringIRType(left.type)) {
                this.func().cmpEqStr(temp, left.register, right.register);
            } else {
                const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
                const leftValue = this.coerceScalarExpression(left, operandType);
                const rightValue = this.coerceScalarExpression(right, operandType);
                const cmpType = this.extractCmpType(operandType, node);
                this.func().cmpEq(temp, leftValue.register, rightValue.register, cmpType);
            }
            return { register: temp, type: boolType };
        }
        if (op === '!=') {
            if (this.isStringIRType(left.type)) {
                this.func().cmpNeStr(temp, left.register, right.register);
            } else {
                const operandType = this.resolveNumericOperandTypeForBinary(node, left, right);
                const leftValue = this.coerceScalarExpression(left, operandType);
                const rightValue = this.coerceScalarExpression(right, operandType);
                const cmpType = this.extractCmpType(operandType, node);
                this.func().cmpNe(temp, leftValue.register, rightValue.register, cmpType);
            }
            return { register: temp, type: boolType };
        }

        // Fallback
        this.func().undef(temp, left.type);
        return { register: temp, type: left.type };
    }

    private visitLogicalAnd(node: ast.BinaryExpression): ExpressionResult {
        const f = this.func();
        const left = this.visitExpression(node.left, undefined);
        const temp = this.tmp();
        const rhsLabel = this.generateLabel('and_rhs');
        const endLabel = this.generateLabel('and_end');

        // Default result for short-circuit false path.
        f.constBool(temp, false);
        // If left is true evaluate RHS, otherwise keep false.
        f.br(left.register, rhsLabel, endLabel);

        f.label(rhsLabel);
        const right = this.visitExpression(node.right, undefined);
        f.mov(temp, right.register, scalarType('bool'));
        f.jmp(endLabel);

        f.label(endLabel);
        return { register: temp, type: scalarType('bool') };
    }

    private visitLogicalOr(node: ast.BinaryExpression): ExpressionResult {
        const f = this.func();
        const left = this.visitExpression(node.left, undefined);
        const temp = this.tmp();
        const rhsLabel = this.generateLabel('or_rhs');
        const endLabel = this.generateLabel('or_end');

        // Default result for short-circuit true path.
        f.constBool(temp, true);
        // If left is true keep true, otherwise evaluate RHS.
        f.br(left.register, endLabel, rhsLabel);

        f.label(rhsLabel);
        const right = this.visitExpression(node.right, undefined);
        f.mov(temp, right.register, scalarType('bool'));
        f.jmp(endLabel);

        f.label(endLabel);
        return { register: temp, type: scalarType('bool') };
    }

    private visitNullCoalescing(node: ast.BinaryExpression): ExpressionResult {
        const f = this.func();
        const left = this.visitExpression(node.left, undefined);
        const temp = this.tmp();
        const nullCheckReg = this.tmp();
        const rhsLabel = this.generateLabel('coalesce_rhs');
        const endLabel = this.generateLabel('coalesce_end');

        f.isNull(nullCheckReg, left.register);
        f.br(nullCheckReg, rhsLabel, endLabel);

        // Left is null, use right
        f.label(rhsLabel);
        const right = this.visitExpression(node.right, undefined);
        f.mov(temp, right.register, right.type);
        f.jmp(endLabel);

        // Left is not null, use left
        f.label(endLabel);
        // We need phi here ideally, but for now use mov before branch
        // Rewrite: emit mov before branches
        return { register: temp, type: left.type };
    }

    // ---- Assignment Expression ----

    private visitAssignmentExpression(node: ast.BinaryExpression): ExpressionResult {
        const op = node.op;
        const lhs = node.left;
        const f = this.func();

        if (op === '=') {
            // Simple assignment
            const rhs = this.visitExpression(node.right, undefined);
            this.storeBack(lhs, rhs);
            return rhs;
        }

        // Compound assignment: load LHS, compute, store back
        const lhsResult = this.visitExpression(lhs, undefined);
        const rhsResult = this.visitExpression(node.right, undefined);

        const baseOp = op.slice(0, -1); // Remove '='

        // Check for operator overload on the base operator
        const lhsTd = this.getType(lhs);
        const rhsTd = this.getType(node.right);
        const overload = this.resolveOperatorMethod(lhsTd, baseOp, [rhsTd]);
        if (overload) {
            const result = this.emitOperatorCall(
                lhsResult, overload.methodId, overload.returnType,
                [rhsResult.register], [rhsResult.type]
            );
            this.storeBack(lhs, result);
            return result;
        }

        const temp = this.tmp();
        const numType = this.extractNumericType(lhsResult.type, node);

        switch (baseOp) {
            case '+':
                if (this.isStringIRType(lhsResult.type)) {
                    f.strConcat(temp, lhsResult.register, rhsResult.register, rhsResult.type);
                } else {
                    f.add(temp, lhsResult.register, rhsResult.register, numType);
                }
                break;
            case '-': f.sub(temp, lhsResult.register, rhsResult.register, numType); break;
            case '*': f.mul(temp, lhsResult.register, rhsResult.register, numType); break;
            case '/': f.div(temp, lhsResult.register, rhsResult.register, numType); break;
            case '%': f.mod(temp, lhsResult.register, rhsResult.register, numType); break;
            case '<<': f.shl(temp, lhsResult.register, rhsResult.register); break;
            case '>>': f.shr(temp, lhsResult.register, rhsResult.register, isSignedInt(lhsResult.type)); break;
            case '&': f.band(temp, lhsResult.register, rhsResult.register); break;
            case '|': f.bor(temp, lhsResult.register, rhsResult.register); break;
            case '^': f.bxor(temp, lhsResult.register, rhsResult.register); break;
            default:
                f.undef(temp, lhsResult.type);
        }

        const result: ExpressionResult = { register: temp, type: lhsResult.type };
        this.storeBack(lhs, result);
        return result;
    }

    /**
     * Store a value back to an LHS expression target
     */
    private storeBack(lhs: ast.Expression, value: ExpressionResult): void {
        const f = this.func();

        if (ast.isQualifiedReference(lhs)) {
            const ref = lhs.reference?.ref;
            if (ref && ast.isVariableDeclSingle(ref)) {
                if (this.isGlobalVar(ref)) {
                    f.globalStore(this.G(ref), value.register, value.type);
                } else {
                    const varInfo = this.lookupVariable(this.getReferenceName(ref));
                    if (varInfo) {
                        f.mov(varInfo.register, value.register, value.type);
                    }
                }
            } else if (ref && (ast.isFunctionParameter(ref) || ast.isDestructuringElement(ref) || ast.isIteratorVar(ref) || ast.isVariablePattern(ref))) {
                const varInfo = this.lookupVariable(this.getReferenceName(ref));
                if (varInfo) {
                    f.mov(varInfo.register, value.register, value.type);
                }
            } else if (ref && ast.isClassAttributeDecl(ref)) {
                // Implicit `this.field = value` for bare class field assignment
                const thisVar = this.lookupVariable('this');
                if (thisVar) {
                    const classType = ref.$container; // ClassType AST node
                    const classTd = this.getType(classType as AstNode);
                    const resolvedClassTd = isReferenceType(classTd) ? this.typeUtils.resolveIfReference(classTd) : classTd;
                    const fieldIndex = this.getClassFieldIndex(resolvedClassTd, ref.name);
                    f.classSet(thisVar.register, fieldIndex, value.register, value.type);
                }
            }
        } else if (ast.isMemberAccess(lhs)) {
            const obj = this.visitExpression(lhs.expr, undefined);
            const memberRef = lhs.element?.ref;
            if (memberRef) {
                // Determine if struct or class
                const objTd = this.getType(lhs.expr);
                const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;

                if (isStructType(resolvedObjTd) || isVariantType(resolvedObjTd) || isVariantConstructorType(resolvedObjTd)) {
                    const fieldIndex = this.getStructFieldIndex(resolvedObjTd, this.getReferenceName(memberRef));
                    f.structSet(obj.register, fieldIndex, value.register, value.type);
                } else if (isClassType(resolvedObjTd)) {
                    const fieldIndex = this.getClassFieldIndex(resolvedObjTd, this.getReferenceName(memberRef));
                    f.classSet(obj.register, fieldIndex, value.register, value.type);
                }
            }
        } else if (ast.isIndexAccess(lhs)) {
            const array = this.visitExpression(lhs.expr, undefined);
            if (lhs.indexes && lhs.indexes.length > 0) {
                const indexResults = lhs.indexes.map(idx => this.visitExpression(idx, undefined));
                const indexTds = lhs.indexes.map(idx => this.getType(idx));
                const valueTd = this.getType(lhs); // This would be element type, but for []=, args = [...indexes, value]

                // Check for []= operator overload
                const objTd = this.getType(lhs.expr);
                const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
                const baseObjTd = isNullableType(resolvedObjTd) ? resolvedObjTd.baseType : resolvedObjTd;
                const allArgTds = [...indexTds, valueTd]; // Approximate: pass index types + value type
                const overload = this.resolveOperatorMethod(objTd, '[]=', allArgTds);
                if (overload) {
                    const allArgRegs = [...indexResults.map(r => r.register), value.register];
                    const allArgIRTypes = [...indexResults.map(r => r.type), value.type];
                    this.emitOperatorCall(
                        { register: array.register, type: array.type },
                        overload.methodId, overload.returnType,
                        allArgRegs, allArgIRTypes
                    );
                } else {
                    if (!isArrayType(baseObjTd)) {
                        throw new Error(
                            `Index assignment lowering failed for non-array type '${baseObjTd.toString()}': no '[]=' overload found`
                        );
                    }
                    // Primitive array set
                    f.arraySet(array.register, indexResults[0].register, value.register, value.type);
                }
            }
        }
    }

    // ---- Unary Expression ----

    private visitUnaryExpression(node: ast.UnaryExpression): ExpressionResult {
        const operand = this.visitExpression(node.expr, undefined);

        // Check for operator overload on the operand
        const operandTd = this.getType(node.expr);
        const overload = this.resolveOperatorMethod(operandTd, node.op, []);
        if (overload) {
            return this.emitOperatorCall(
                operand, overload.methodId, overload.returnType,
                [], []
            );
        }

        const temp = this.tmp();
        const f = this.func();

        switch (node.op) {
            case '-': {
                const numType = this.extractNumericType(operand.type, node);
                f.neg(temp, operand.register, numType);
                return { register: temp, type: operand.type };
            }
            case '!': {
                f.not(temp, operand.register);
                return { register: temp, type: scalarType('bool') };
            }
            case '~': {
                f.bnot(temp, operand.register);
                return { register: temp, type: operand.type };
            }
            case '+': {
                // Identity
                f.mov(temp, operand.register, operand.type);
                return { register: temp, type: operand.type };
            }
            case '++': {
                // Prefix increment
                const numType = this.extractNumericType(operand.type, node);
                const oneReg = this.tmp();
                f.constInt(oneReg, 1, numType as IntType);
                f.add(temp, operand.register, oneReg, numType);
                this.storeBack(node.expr, { register: temp, type: operand.type });
                return { register: temp, type: operand.type };
            }
            case '--': {
                // Prefix decrement
                const numType = this.extractNumericType(operand.type, node);
                const oneReg = this.tmp();
                f.constInt(oneReg, 1, numType as IntType);
                f.sub(temp, operand.register, oneReg, numType);
                this.storeBack(node.expr, { register: temp, type: operand.type });
                return { register: temp, type: operand.type };
            }
            default: {
                f.undef(temp, operand.type);
                return { register: temp, type: operand.type };
            }
        }
    }

    // ---- Postfix Op ----

    private visitPostfixOp(node: ast.PostfixOp): ExpressionResult {
        const operand = this.visitExpression(node.expr, undefined);

        // Check for operator overload (++ or --)
        const operandTd = this.getType(node.expr);
        const overload = this.resolveOperatorMethod(operandTd, node.op, []);
        if (overload) {
            // For postfix, save original value before calling overload
            const temp = this.tmp();
            this.func().mov(temp, operand.register, operand.type);
            const newResult = this.emitOperatorCall(
                operand, overload.methodId, overload.returnType,
                [], []
            );
            this.storeBack(node.expr, newResult);
            return { register: temp, type: operand.type };
        }

        const temp = this.tmp(); // Save original value
        const newVal = this.tmp();
        const f = this.func();

        f.mov(temp, operand.register, operand.type);

        const numType = this.extractNumericType(operand.type, node);
        const oneReg = this.tmp();
        f.constInt(oneReg, 1, numType as IntType);

        if (node.op === '++') {
            f.add(newVal, operand.register, oneReg, numType);
        } else {
            f.sub(newVal, operand.register, oneReg, numType);
        }

        this.storeBack(node.expr, { register: newVal, type: operand.type });

        // Return original value (postfix)
        return { register: temp, type: operand.type };
    }

    // ============================================================================
    // References & Calls
    // ============================================================================

    private visitQualifiedReference(node: ast.QualifiedReference): ExpressionResult {
        const ref = node.reference?.ref;
        this.assert(ref !== undefined, "Invalid reference");

        // Function parameter or local variable
        if (ast.isFunctionParameter(ref) || ast.isVariableDeclSingle(ref)) {
            const varName = this.getReferenceName(ref);

            if (ast.isVariableDeclSingle(ref) && this.isGlobalVar(ref)) {
                const temp = this.tmp();
                const type = this.getNodeIRType(ref);
                this.func().globalLoad(temp, this.G(ref), type);
                return { register: temp, type };
            }

            const varInfo = this.lookupVariable(varName);
            if (varInfo) {
                return { register: varInfo.register, type: varInfo.type };
            }
            // Parameter not in variables map - use name directly
            const type = this.getNodeIRType(ref);
            return { register: varName, type };
        }

        // Destructuring element (from tuple/array/struct unpacking)
        // Iterator variable (from foreach loops)
        // Variable pattern (from match patterns)
        if (ast.isDestructuringElement(ref) || ast.isIteratorVar(ref) || ast.isVariablePattern(ref)) {
            const varName = ref.name ?? '_';
            const varInfo = this.lookupVariable(varName);
            if (varInfo) {
                return { register: varInfo.register, type: varInfo.type };
            }
            // Fallback: infer type from node
            const type = this.getNodeIRType(ref);
            return { register: varName, type };
        }

        // Function reference (as value → closure_alloc)
        if (ast.isFunctionDeclaration(ref)) {
            const temp = this.tmp();
            const funcName = this.C(ref);
            this.func().closureAlloc(temp, funcName);
            return { register: temp, type: ptrType('closure') };
        }

        // Enum case
        if (ast.isEnumCase(ref)) {
            const temp = this.tmp();
            const enumDecl = ref.$container;
            const enumTd = this.getType(enumDecl as AstNode);
            const irType = this.convertTypeDescriptionToIR(enumTd);
            const intType = (irType.tag === 'scalar' ? irType.scalar : 'u32') as IntType;
            // Get enum case value
            const value = ref.init !== undefined ? this.parseIntegerLiteral(ref.init.value) : BigInt(this.getEnumCaseIndex(ref));
            this.func().constInt(temp, value, intType);
            return { register: temp, type: irType };
        }

        // Variant constructor reference (used in function call dispatch)
        if (ast.isVariantConstructor(ref)) {
            // This will be handled in visitFunctionCall when called
            // Return a placeholder - variant constructors are not first-class values
            const temp = this.tmp();
            this.func().undef(temp, ptrType('struct'));
            return { register: temp, type: ptrType('struct') };
        }

        // FFI extern declaration — emit ffi_register in current function
        if (ast.isExternFFIDecl(ref)) {
            const libname = ref.dynlib;
            // Ensure library is registered in ffiRegistery
            if (!this.ffiRegistery.has(libname)) {
                this.ffiRegistery.register(libname);
            }
            const id = this.ffiRegistery.get(libname);
            const handleReg = `%ffi_${id}`;
            // Emit ffi_register in current function (idempotent at runtime)
            this.func().ffiRegister(handleReg, libname);
            return { register: handleReg, type: ptrType('ffi_handle') };
        }

        // Class field access (implicit `this`) — e.g. `data` inside a method means `this.data`
        if (ast.isClassAttributeDecl(ref)) {
            const thisVar = this.lookupVariable('this');
            this.assert(thisVar !== undefined, "ClassAttributeDecl reference outside of method context");
            const classType = ref.$container; // ClassType AST node
            const classTd = this.getType(classType as AstNode);
            const resolvedClassTd = isReferenceType(classTd) ? this.typeUtils.resolveIfReference(classTd) : classTd;
            const fieldIndex = this.getClassFieldIndex(resolvedClassTd, ref.name);
            const resultType = this.getNodeIRType(node);
            const temp = this.tmp();
            this.func().classGet(temp, thisVar!.register, fieldIndex, resultType);
            return { register: temp, type: resultType };
        }

        // TypeDeclaration used as a namespace prefix (e.g., EnumType.Case, Type.staticMethod)
        // The actual member access is handled by visitMemberAccess or visitFunctionCall
        if (ast.isTypeDeclaration(ref)) {
            const temp = this.tmp();
            const type = this.getNodeIRType(node);
            this.func().undef(temp, type);
            return { register: temp, type };
        }

        // NamespaceDecl used as a prefix (e.g., namespace.function)
        if (ast.isNamespaceDecl(ref)) {
            const temp = this.tmp();
            this.func().undef(temp, voidType());
            return { register: temp, type: voidType() };
        }

        throw new Error("Not implemented for " + ref?.$type);
    }

    private getEnumCaseIndex(enumCase: ast.EnumCase): number {
        const enumDecl = enumCase.$container;
        if (ast.isEnumType(enumDecl)) {
            return enumDecl.cases.indexOf(enumCase);
        }
        return 0;
    }

    // ---- Function Call ----

    private visitFunctionCall(node: ast.FunctionCall): ExpressionResult {
        const f = this.func();

        // Check if this is a variant constructor call
        if (ast.isQualifiedReference(node.expr)) {
            const ref = node.expr.reference?.ref;
            if (ref && ast.isVariantConstructor(ref)) {
                return this.visitVariantConstruction(node, ref);
            }
        }

        // Evaluate arguments
        const argRegs: VReg[] = [];
        const argTypes: IRType[] = [];
        if (node.args) {
            for (const arg of node.args) {
                const argResult = this.visitExpression(arg, undefined);
                argRegs.push(argResult.register);
                argTypes.push(argResult.type);
            }
        }

        // Expand default arguments for any missing parameters
        this.expandDefaultArguments(node, argRegs, argTypes);

        // Determine call type based on expression
        if (ast.isMemberAccess(node.expr)) {
            return this.visitMethodCall(node, argRegs, argTypes);
        }

        if (ast.isQualifiedReference(node.expr)) {
            const ref = node.expr.reference?.ref;

            if (ref && ast.isFunctionDeclaration(ref)) {
                // Direct function call
                let funcName = this.C(ref);
                if (ref.genericParameters && ref.genericParameters.length > 0) {
                    const calleeType = this.typeProvider.getType(node.expr);
                    const resolvedCalleeType = isReferenceType(calleeType) ? this.typeUtils.resolveIfReference(calleeType) : calleeType;
                    const parameterTypes = isFunctionType(resolvedCalleeType)
                        ? resolvedCalleeType.parameters.map(p => p.type)
                        : (ref.header?.args || []).map(p => this.typeProvider.getType(p));

                    const inferredTypeArgs = this.resolveGenericCallTypeArgs(node, ref.genericParameters, parameterTypes);
                    if (!inferredTypeArgs) {
                        throw new Error(`Unable to resolve generic arguments for function call '${ref.name}'`);
                    }
                    funcName = this.callableRegistry.getGenericFunctionName(ref, inferredTypeArgs);
                }
                const retTd = this.getType(node);
                const retType = this.convertTypeDescriptionToIR(retTd);
                const retTypes = retType.tag === 'void' ? [] : [retType];
                const dests = retType.tag === 'void' ? [] : [this.tmp()];

                f.call(dests, funcName, argRegs, argTypes, retTypes);

                if (dests.length > 0) {
                    return { register: dests[0], type: retTypes[0] };
                }
                return { register: this.tmp(), type: voidType() };
            }

            // Variable holding a closure
            const varInfo = this.lookupVariable(this.getReferenceName(ref));
            if (varInfo && varInfo.type.tag === 'ptr' && varInfo.type.kind === 'closure') {
                const retTd = this.getType(node);
                const retType = this.convertTypeDescriptionToIR(retTd);
                const retTypes = retType.tag === 'void' ? [] : [retType];
                const dests = retType.tag === 'void' ? [] : [this.tmp()];

                f.callClosure(dests, varInfo.register, argRegs, argTypes, retTypes);

                if (dests.length > 0) {
                    return { register: dests[0], type: retTypes[0] };
                }
                return { register: this.tmp(), type: voidType() };
            }
        }

        // Check for () operator overload (callable objects)
        {
            const exprTd = this.getType(node.expr);
            const argTds = node.args ? node.args.map(a => this.getType(a)) : [];
            const overload = this.resolveOperatorMethod(exprTd, '()', argTds);
            if (overload) {
                const objResult = this.visitExpression(node.expr, undefined);
                return this.emitOperatorCall(
                    objResult, overload.methodId, overload.returnType,
                    argRegs, argTypes
                );
            }
        }

        // Generic fallback: evaluate expression and call
        const funcExpr = this.visitExpression(node.expr, undefined);
        const retTd = this.getType(node);
        const retType = this.convertTypeDescriptionToIR(retTd);
        const retTypes = retType.tag === 'void' ? [] : [retType];
        const dests = retType.tag === 'void' ? [] : [this.tmp()];

        if (funcExpr.type.tag === 'ptr' && funcExpr.type.kind === 'closure') {
            f.callClosure(dests, funcExpr.register, argRegs, argTypes, retTypes);
        } else {
            // Fallback to direct call with register name
            f.call(dests, funcExpr.register, argRegs, argTypes, retTypes);
        }

        if (dests.length > 0) {
            return { register: dests[0], type: retTypes[0] };
        }
        return { register: this.tmp(), type: voidType() };
    }

    private visitMethodCall(
        node: ast.FunctionCall,
        argRegs: VReg[],
        argTypes: IRType[]
    ): ExpressionResult {
        const f = this.func();
        const memberAccess = node.expr as ast.MemberAccess;
        const obj = this.visitExpression(memberAccess.expr, undefined);
        const memberRef = memberAccess.element?.ref;

        const retTd = this.getType(node);
        const retType = this.convertTypeDescriptionToIR(retTd);
        const retTypes = retType.tag === 'void' ? [] : [retType];
        const dests = retType.tag === 'void' ? [] : [this.tmp()];

        // Check if FFI call
        const objTd = this.getType(memberAccess.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;

        // Variant constructor via member access (e.g., AssertionResult.Ok())
        if (memberRef && ast.isVariantConstructor(memberRef)) {
            return this.visitVariantConstruction(node, memberRef);
        }

        // Builtin prototype method calls (array.resize, string.cat, coro.reset, etc.)
        if (memberRef && ast.isBuiltinSymbolFn(memberRef)) {
            const methodName = this.getReferenceName(memberRef);
            return this.visitBuiltinMethodCall(
                resolvedObjTd, methodName, obj, argRegs, argTypes, dests, retTypes
            );
        }

        // Field with function type — load field and call as closure
        if (memberRef && ast.isClassAttributeDecl(memberRef)) {
            const memberTd = this.getType(memberAccess);
            const resolvedMemberTd = isReferenceType(memberTd) ? this.typeUtils.resolveIfReference(memberTd) : memberTd;
            if (isFunctionType(resolvedMemberTd)) {
                const fieldName = this.getReferenceName(memberRef);
                const fieldIndex = this.getClassFieldIndex(resolvedObjTd, fieldName);
                const closureReg = this.tmp();
                f.classGet(closureReg, obj.register, fieldIndex, ptrType('closure'));
                f.callClosure(dests, closureReg, argRegs, argTypes, retTypes);
                if (dests.length > 0) {
                    return { register: dests[0], type: retTypes[0] };
                }
                return { register: this.tmp(), type: voidType() };
            }
        }

        if (isFFIType(resolvedObjTd)) {
            // FFI method call — resolve method index from extern block order
            const ffiTd = resolvedObjTd as FFITypeDescription;
            const ffiMethodName = memberRef ? this.getReferenceName(memberRef) : 'unknown';
            const methodId = ffiTd.methods.findIndex(m => m.names.includes(ffiMethodName));
            f.callFFI(dests, obj.register, methodId >= 0 ? methodId : 0, argRegs, argTypes, retTypes);
        } else if (isClassType(resolvedObjTd)) {
            // Concrete class type — direct call (no vtable dispatch needed)
            if (memberRef) {
                const methodName = this.getReferenceName(memberRef);
                let classNode = resolvedObjTd.node;
                // Navigate from ClassType to its parent TypeDeclaration if needed
                if (classNode && ast.isClassType(classNode) && classNode.$container && ast.isTypeDeclaration(classNode.$container)) {
                    classNode = classNode.$container;
                }
                const className = classNode && ast.isTypeDeclaration(classNode)
                    ? this.classNodeToIRName.get(classNode) || classNode.name
                    : undefined;
                if (className) {
                    // Check if the method is generic and resolve type arguments
                    let methodHeader: ast.MethodHeader | undefined;
                    if (ast.isClassMethod(memberRef)) {
                        methodHeader = memberRef.method;
                    } else if (ast.isMethodHeader(memberRef)) {
                        methodHeader = memberRef;
                    }

                    let funcName: string;
                    if (methodHeader && methodHeader.genericParameters && methodHeader.genericParameters.length > 0) {
                        const memberType = this.typeProvider.getType(memberAccess);
                        const resolvedMemberType = isReferenceType(memberType) ? this.typeUtils.resolveIfReference(memberType) : memberType;
                        const parameterTypes = isFunctionType(resolvedMemberType)
                            ? resolvedMemberType.parameters.map(p => p.type)
                            : (methodHeader.header?.args || []).map(p => this.typeProvider.getType(p));

                        const methodTypeArgs = this.resolveGenericCallTypeArgs(node, methodHeader.genericParameters, parameterTypes);
                        if (!methodTypeArgs) {
                            throw new Error(`Unable to resolve generic arguments for method call '${methodName}' on class '${className}'`);
                        }
                        const classDecl = classNode && ast.isTypeDeclaration(classNode) ? classNode : undefined;
                        funcName = this.callableRegistry.getGenericMethodName(
                            className,
                            methodHeader,
                            methodTypeArgs,
                            classDecl
                        );
                    } else {
                        funcName = this.monoMorph.mangleName(`${className}::${methodName}`);
                    }
                    f.call(dests, funcName, [obj.register, ...argRegs], [obj.type, ...argTypes], retTypes);
                } else {
                    // Fallback to vtable dispatch if class name unknown
                    const methodId = this.getMethodId(resolvedObjTd, methodName);
                    f.callMethod(dests, obj.register, methodId, argRegs, argTypes, retTypes);
                }
            } else {
                f.callMethod(dests, obj.register, 0, argRegs, argTypes, retTypes);
            }
        } else if (isInterfaceType(resolvedObjTd)) {
            // Interface type — vtable dispatch via colored method slots
            if (memberRef) {
                const methodName = this.getReferenceName(memberRef);
                const methodId = this.getMethodId(resolvedObjTd, methodName);
                f.callMethod(dests, obj.register, methodId, argRegs, argTypes, retTypes);
            } else {
                f.callMethod(dests, obj.register, 0, argRegs, argTypes, retTypes);
            }
        } else {
            // Fallback: treat as direct call with mangled name
            const methodName = memberRef ? this.getReferenceName(memberRef) : 'unknown';
            f.call(dests, methodName, [obj.register, ...argRegs], [obj.type, ...argTypes], retTypes);
        }

        if (dests.length > 0) {
            return { register: dests[0], type: retTypes[0] };
        }
        return { register: this.tmp(), type: voidType() };
    }

    // ---- Default Argument Expansion ----

    /**
     * Expands default arguments at the call site.
     * When a function call provides fewer arguments than parameters,
     * this evaluates the default expressions and appends them to the arg lists.
     */
    private expandDefaultArguments(
        node: ast.FunctionCall,
        argRegs: VReg[],
        argTypes: IRType[]
    ): void {
        const params = this.resolveCallTargetParams(node);
        if (!params) return;
        if (argRegs.length >= params.length) return;

        // For each missing argument, evaluate its default expression
        for (let i = argRegs.length; i < params.length; i++) {
            const defaultExpr = params[i].defaultValue;
            if (!defaultExpr) return; // No more defaults (shouldn't happen post-validation)
            const result = this.visitExpression(defaultExpr, undefined);
            argRegs.push(result.register);
            argTypes.push(result.type);
        }
    }

    /**
     * Resolve the target function/method parameters from a function call node.
     * Returns the FunctionParameter[] array from the AST declaration, or undefined.
     *
     * Returns undefined for indirect calls (lambdas, closure variables, () operator).
     * This is intentional: stripFunctionDefaults() in the type provider removes hasDefault
     * when a function is used as a value, so the type checker rejects indirect calls with
     * too few arguments. The compiler never needs to expand defaults for these cases.
     */
    private resolveCallTargetParams(node: ast.FunctionCall): ast.FunctionParameter[] | undefined {
        if (ast.isMemberAccess(node.expr)) {
            const ref = node.expr.element?.ref;
            if (ref && ast.isClassMethod(ref)) {
                return ref.method?.header?.args;
            }
            if (ref && ast.isMethodHeader(ref)) {
                return ref.header?.args;
            }
            if (ref && ast.isImplementationMethodDecl(ref)) {
                return ref.method?.header?.args;
            }
        }

        if (ast.isQualifiedReference(node.expr)) {
            const ref = node.expr.reference?.ref;
            if (ref && ast.isFunctionDeclaration(ref)) {
                return ref.header?.args;
            }
            if (ref && ast.isClassMethod(ref)) {
                return ref.method?.header?.args;
            }
            if (ref && ast.isMethodHeader(ref)) {
                return ref.header?.args;
            }
        }

        return undefined;
    }

    /**
     * Resolve the init method's AST parameters from a NewExpression node.
     * Returns the FunctionParameter[] array from the init method, or undefined if not found.
     */
    private resolveInitMethodParams(node: ast.NewExpression): ast.FunctionParameter[] | undefined {
        const refType = node.instanceType;
        if (refType && ast.isReferenceType(refType)) {
            const classDecl = refType.field?.ref;
            if (classDecl && ast.isTypeDeclaration(classDecl) && ast.isClassType(classDecl.definition)) {
                const classDef = classDecl.definition;
                const initMethods = classDef.methods.filter(m => m.method?.names?.includes('init'));
                const argCount = node.args?.length ?? 0;
                // Find the overload whose arity range matches the provided argument count
                const match = initMethods.find(m => {
                    const params = m.method?.header?.args ?? [];
                    const minArity = params.filter(p => !p.defaultValue).length;
                    return argCount >= minArity && argCount <= params.length;
                });
                return match?.method?.header?.args;
            }
        }
        return undefined;
    }

    // ---- Builtin Prototype Method Call ----

    private visitBuiltinMethodCall(
        objTd: TypeDescription,
        methodName: string,
        obj: ExpressionResult,
        argRegs: VReg[],
        argTypes: IRType[],
        dests: VReg[],
        retTypes: IRType[]
    ): ExpressionResult {
        const f = this.func();

        // --- Array builtins ---
        if (isArrayType(objTd)) {
            if (methodName === 'resize') {
                f.arrayExtend(obj.register, argRegs[0]);
                return { register: this.tmp(), type: voidType() };
            }
            if (methodName === 'slice') {
                const dest = dests.length > 0 ? dests[0] : this.tmp();
                f.arraySlice(dest, obj.register, argRegs[0], argRegs[1]);
                return { register: dest, type: ptrType('array') };
            }
        }

        // --- String builtins ---
        if (isStringType(objTd) || isStringLiteralType(objTd)) {
            if (methodName === 'cat') {
                const dest = dests.length > 0 ? dests[0] : this.tmp();
                f.strConcat(dest, obj.register, argRegs[0], argTypes[0]);
                return { register: dest, type: ptrType('string') };
            }
        }

        // --- Coroutine builtins ---
        if (isCoroutineType(objTd)) {
            if (methodName === 'reset') {
                f.coroReset(obj.register);
                return { register: this.tmp(), type: voidType() };
            }
            if (methodName === 'finish') {
                f.coroFinish(obj.register);
                return { register: this.tmp(), type: voidType() };
            }
        }

        // Fallback: emit as a builtin call (for builtins without dedicated IR, future FFI)
        f.call(dests, `builtin_${methodName}`, [obj.register, ...argRegs], [obj.type, ...argTypes], retTypes);
        if (dests.length > 0) {
            return { register: dests[0], type: retTypes[0] };
        }
        return { register: this.tmp(), type: voidType() };
    }

    // ============================================================================
    // Member & Index Access
    // ============================================================================

    private visitMemberAccess(node: ast.MemberAccess): ExpressionResult {
        const memberRef = node.element?.ref;
        const temp = this.tmp();

        if (!memberRef) {
            this.func().undef(temp, voidType());
            return { register: temp, type: voidType() };
        }

        // Enum case access (e.g., FileOpenMode.Read) — no need to evaluate the type as a value
        if (ast.isEnumCase(memberRef)) {
            const enumDecl = memberRef.$container;
            const enumTd = this.getType(enumDecl as AstNode);
            const irType = this.convertTypeDescriptionToIR(enumTd);
            const intType = (irType.tag === 'scalar' ? irType.scalar : 'u32') as IntType;
            const value = memberRef.init !== undefined ? this.parseIntegerLiteral(memberRef.init.value) : BigInt(this.getEnumCaseIndex(memberRef));
            this.func().constInt(temp, value, intType);
            return { register: temp, type: irType };
        }

        const obj = this.visitExpression(node.expr, undefined);
        const memberName = this.getReferenceName(memberRef);
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const resultType = this.getNodeIRType(node);

        // Array .length
        if (isArrayType(resolvedObjTd) && memberName === 'length') {
            this.func().arrayLength(temp, obj.register);
            return { register: temp, type: scalarType('u64') };
        }

        // Coroutine .state
        if (isCoroutineType(resolvedObjTd) && memberName === 'state') {
            this.func().coroState(temp, obj.register);
            return { register: temp, type: scalarType('u8') };
        }

        // Coroutine .alive (state != Completed, where Completed = 3)
        if (isCoroutineType(resolvedObjTd) && memberName === 'alive') {
            const stateReg = this.tmp();
            this.func().coroState(stateReg, obj.register);
            const completedReg = this.tmp();
            this.func().constInt(completedReg, 3n, 'u8');
            this.func().cmpNe(temp, stateReg, completedReg, 'u8');
            return { register: temp, type: scalarType('bool') };
        }

        // Struct field access
        if (isStructType(resolvedObjTd) || isVariantType(resolvedObjTd) || isVariantConstructorType(resolvedObjTd)) {
            const fieldIndex = this.getStructFieldIndex(resolvedObjTd, memberName);
            this.func().structGet(temp, obj.register, fieldIndex, resultType);
            return { register: temp, type: resultType };
        }

        // Class field access
        if (isClassType(resolvedObjTd)) {
            const fieldIndex = this.getClassFieldIndex(resolvedObjTd, memberName);
            this.func().classGet(temp, obj.register, fieldIndex, resultType);
            return { register: temp, type: resultType };
        }

        // Fallback
        this.func().undef(temp, resultType);
        return { register: temp, type: resultType };
    }

    private visitIndexAccess(node: ast.IndexAccess): ExpressionResult {
        const obj = this.visitExpression(node.expr, undefined);

        // Check for [] operator overload
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const baseObjTd = isNullableType(resolvedObjTd) ? resolvedObjTd.baseType : resolvedObjTd;
        if (node.indexes && node.indexes.length > 0) {
            const indexResults = node.indexes.map(idx => this.visitExpression(idx, undefined));
            const indexTds = node.indexes.map(idx => this.getType(idx));
            const overload = this.resolveOperatorMethod(objTd, '[]', indexTds);
            if (overload) {
                return this.emitOperatorCall(
                    obj, overload.methodId, overload.returnType,
                    indexResults.map(r => r.register),
                    indexResults.map(r => r.type)
                );
            }

            if (!isArrayType(baseObjTd)) {
                throw new Error(
                    `Index access lowering failed for non-array type '${baseObjTd.toString()}': no '[]' overload found`
                );
            }
            // Primitive array access
            const index = indexResults[0];
            const elemType = this.getNodeIRType(node);
            const temp = this.tmp();
            this.func().arrayGet(temp, obj.register, index.register, elemType);
            return { register: temp, type: elemType };
        }

        const temp = this.tmp();
        const resultType = this.getNodeIRType(node);
        this.func().undef(temp, resultType);
        return { register: temp, type: resultType };
    }

    // ============================================================================
    // Construction: Struct, Array, Variant, New
    // ============================================================================

    private visitStructConstruction(node: ast.Expression): ExpressionResult {
        const f = this.func();
        const temp = this.tmp();
        const resultType = ptrType('struct') as IRType;

        if (ast.isNamedStructConstructionExpression(node)) {
            // Named struct: { fieldName: value, ... }
            const structTd = this.getType(node);
            const shapeId = this.getOrDeclareStructShape(structTd);
            f.structAlloc(temp, shapeId);

            const structFields = isStructType(structTd) ? (structTd as StructTypeDescription).fields : [];
            let targetFieldPos = 0; // tracks which target field we're writing to
            for (let i = 0; i < node.fields.length; i++) {
                const field = node.fields[i];
                if (ast.isStructFieldKeyValuePair(field)) {
                    const nameId = this.getOrCreateFieldNameId(field.name);
                    const fieldValue = this.visitExpression(field.expr, undefined);
                    f.structSet(temp, nameId, fieldValue.register, fieldValue.type);
                    targetFieldPos++;
                } else if (ast.isStructSpreadExpression(field)) {
                    // Spread: copy all fields from the source struct
                    const srcResult = this.visitExpression(field.expression, undefined);
                    const srcTd = this.getType(field.expression);
                    const resolvedSrc = isReferenceType(srcTd) ? this.typeUtils.resolveIfReference(srcTd) : srcTd;
                    if (isStructType(resolvedSrc)) {
                        const srcFields = (resolvedSrc as StructTypeDescription).fields;
                        for (let si = 0; si < srcFields.length; si++) {
                            const srcFieldType = this.convertTypeDescriptionToIR(srcFields[si].type);
                            const srcNameId = this.getOrCreateFieldNameId(srcFields[si].name);
                            const tgtNameId = targetFieldPos < structFields.length
                                ? this.getOrCreateFieldNameId(structFields[targetFieldPos].name)
                                : srcNameId;
                            const srcFieldReg = this.tmp();
                            f.structGet(srcFieldReg, srcResult.register, srcNameId, srcFieldType);
                            f.structSet(temp, tgtNameId, srcFieldReg, srcFieldType);
                            targetFieldPos++;
                        }
                    }
                }
            }

            return { register: temp, type: resultType };
        }

        if (ast.isAnonymousStructConstructionExpression(node)) {
            // Anonymous struct: { value1, value2, ... }
            const structTd = this.getType(node);
            const shapeId = this.getOrDeclareStructShape(structTd);
            f.structAlloc(temp, shapeId);

            const anonStructFields = isStructType(structTd) ? (structTd as StructTypeDescription).fields : [];
            for (let i = 0; i < node.expressions.length; i++) {
                const fieldValue = this.visitExpression(node.expressions[i], undefined);
                const nameId = i < anonStructFields.length
                    ? this.getOrCreateFieldNameId(anonStructFields[i].name)
                    : i;
                f.structSet(temp, nameId, fieldValue.register, fieldValue.type);
            }

            return { register: temp, type: resultType };
        }

        f.undef(temp, resultType);
        return { register: temp, type: resultType };
    }

    private visitArrayConstruction(node: ast.ArrayConstructionExpression): ExpressionResult {
        const f = this.func();
        const temp = this.tmp();

        // Get element type from the array's type
        const arrayTd = this.getType(node);
        let elemType: IRType = voidType();
        if (isArrayType(arrayTd)) {
            elemType = this.convertTypeDescriptionToIR((arrayTd as ArrayTypeDescription).elementType);
        }

        // Allocate array
        const values = node.values ?? [];
        const sizeReg = this.tmp();
        f.constInt(sizeReg, values.length, 'u64');
        f.arrayAlloc(temp, elemType, sizeReg);

        // Set elements
        for (let i = 0; i < values.length; i++) {
            const elem = values[i];
            if (ast.isArraySpreadExpression(elem)) {
                // Spread: extend array with source elements
                const srcArray = this.visitExpression(elem.expr, undefined);
                const srcLen = this.tmp();
                f.arrayLength(srcLen, srcArray.register);
                f.arrayExtend(temp, srcLen);

                // Copy elements from source array
                // Generate a loop: for j = 0; j < srcLen; j++ { arr[destIdx++] = src[j] }
                const loopStart = this.generateLabel('spread_loop');
                const loopEnd = this.generateLabel('spread_end');
                const jReg = this.tmp();
                const destIdxReg = this.tmp();
                const cmpReg = this.tmp();

                f.constInt(jReg, 0, 'u64');
                f.constInt(destIdxReg, i, 'u64'); // Start dest index at current position

                f.label(loopStart);
                f.cmpLt(cmpReg, jReg, srcLen, 'u64');
                const loopBody = this.generateLabel('spread_body');
                f.br(cmpReg, loopBody, loopEnd);

                f.label(loopBody);
                const srcElem = this.tmp();
                f.arrayGet(srcElem, srcArray.register, jReg, elemType);
                f.arraySet(temp, destIdxReg, srcElem, elemType);

                const oneReg = this.tmp();
                f.constInt(oneReg, 1, 'u64');
                f.add(jReg, jReg, oneReg, 'u64');
                f.add(destIdxReg, destIdxReg, oneReg, 'u64');
                f.jmp(loopStart);

                f.label(loopEnd);
            } else if (ast.isExpressionElement(elem)) {
                const elemResult = this.visitExpression(elem.expr, undefined);
                const idxReg = this.tmp();
                f.constInt(idxReg, i, 'u64');
                f.arraySet(temp, idxReg, elemResult.register, elemType);
            }
        }

        return { register: temp, type: ptrType('array') };
    }

    /**
     * Variant construction: VariantName.Constructor(args...)
     * Layout: field #0 = u8 tag, field #1..N = constructor args
     */
    private visitVariantConstruction(
        node: ast.FunctionCall,
        constructorRef: ast.VariantConstructor
    ): ExpressionResult {
        const f = this.func();
        const temp = this.tmp();

        // Get variant type info
        const variantTd = this.getType(node);
        const shapeId = this.getOrDeclareStructShape(variantTd);
        f.structAlloc(temp, shapeId);

        // Set tag via field name ID
        const tagReg = this.tmp();
        const tagValue = this.getVariantConstructorTag(constructorRef);
        f.constInt(tagReg, tagValue, 'u8');
        f.structSet(temp, this.getOrCreateFieldNameId('$tag'), tagReg, scalarType('u8'));

        // Set constructor arguments via field name IDs
        if (node.args && isVariantConstructorType(variantTd)) {
            const vcTd = variantTd as VariantConstructorTypeDescription;
            const constructor = vcTd.baseVariant.constructors.find(c => c.name === vcTd.constructorName);
            if (!constructor) {
                throw new Error(`Variant constructor '${vcTd.constructorName}' not found in variant type`);
            }
            for (let i = 0; i < node.args.length; i++) {
                const argResult = this.visitExpression(node.args[i], undefined);
                const nameId = this.getOrCreateFieldNameId(constructor.parameters[i].name);
                f.structSet(temp, nameId, argResult.register, argResult.type);
            }
        }

        return { register: temp, type: ptrType('struct') };
    }

    private visitNewExpression(node: ast.NewExpression): ExpressionResult {
        const f = this.func();
        const temp = this.tmp();

        const classKey = this.getClassShapeKey(node);
        f.classAlloc(temp, classKey);

        // Evaluate provided arguments
        const argRegs: VReg[] = [];
        const argTypes: IRType[] = [];
        if (node.args) {
            for (const arg of node.args) {
                const argResult = this.visitExpression(arg, undefined);
                argRegs.push(argResult.register);
                argTypes.push(argResult.type);
            }
        }

        // Expand default arguments for init method
        const initParams = this.resolveInitMethodParams(node);
        if (initParams && argRegs.length < initParams.length) {
            for (let i = argRegs.length; i < initParams.length; i++) {
                const defaultExpr = initParams[i].defaultValue;
                if (!defaultExpr) break;
                const result = this.visitExpression(defaultExpr, undefined);
                argRegs.push(result.register);
                argTypes.push(result.type);
            }
        }

        // Call init method if there are arguments (including expanded defaults)
        if (argRegs.length > 0) {
            // Convention: init method ID is 0
            f.callMethod([], temp, 0, argRegs, argTypes, []);
        }

        return { register: temp, type: ptrType('class') };
    }

    // ============================================================================
    // Lambda / Closure
    // ============================================================================

    private visitLambdaExpression(node: ast.LambdaExpression): ExpressionResult {
        const f = this.func();

        // 1. Analyze upvalues
        const upvalues = this.collectUpvalues(node);

        // 2. Generate backing function
        const closureName = `$lambda_${this.closureCounter++}`;

        // Build params: env params first, then user params
        const params: FunctionParam[] = [];

        // Env params (captured upvalues)
        for (const uv of upvalues) {
            params.push({ name: uv.name, type: uv.type });
        }

        // User params
        for (const param of node.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            params.push({ name: param.name, type: paramType });
        }

        // Return type
        const returnTypes: IRType[] = [];
        if (node.header.returnType) {
            returnTypes.push(this.convertTypeWithSubstitution(node.header.returnType));
        }

        const closureFunc = this.program.createFunction(
            closureName, params, returnTypes,
            { isClosure: true }
        );

        // Save context
        const prevFunction = this.context.currentFunction;
        const prevVars = new Map(this.context.variables);
        const prevTemp = this.context.tempCounter;
        const prevLabel = this.context.labelCounter;
        const prevScope = this.context.scopeDepth;

        this.context.currentFunction = closureFunc;
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map env params to variables
        for (const uv of upvalues) {
            this.context.variables.set(uv.name, { register: uv.name, type: uv.type });
        }

        // Map user params to variables
        for (const param of node.header.args) {
            const paramType = param.type
                ? this.convertTypeWithSubstitution(param.type)
                : voidType();
            this.context.variables.set(param.name, { register: param.name, type: paramType });
        }

        // Generate body
        if (node.body) {
            if (ast.isBlockStatement(node.body)) {
                this.visitBlockStatement(node.body);
            } else {
                // Expression body
                const result = this.visitExpression(node.body as ast.Expression, undefined);
                closureFunc.closureRet([result.register], [result.type]);
            }
        } else if (node.expr) {
            const result = this.visitExpression(node.expr, undefined);
            closureFunc.closureRet([result.register], [result.type]);
        }

        // Ensure closure ends with a return (implicit void return)
        const lastClosureInst = closureFunc.instructions[closureFunc.instructions.length - 1];
        if (!lastClosureInst || (lastClosureInst.kind !== 'closure_ret' && lastClosureInst.kind !== 'ret' && lastClosureInst.kind !== 'exit')) {
            closureFunc.closureRet();
        }

        // Restore context
        this.context.currentFunction = prevFunction;
        this.context.variables = prevVars;
        this.context.tempCounter = prevTemp;
        this.context.labelCounter = prevLabel;
        this.context.scopeDepth = prevScope;

        // 3. Generate closure_alloc + push_env in enclosing function
        const closureReg = this.tmp();
        f.closureAlloc(closureReg, closureName);

        for (const uv of upvalues) {
            f.closurePushEnv(closureReg, uv.register, uv.type);
        }

        return { register: closureReg, type: ptrType('closure') };
    }

    /**
     * Collect upvalues for a lambda by walking its body and finding references
     * to variables from enclosing scopes.
     */
    private collectUpvalues(node: ast.LambdaExpression): CapturedUpvalue[] {
        const upvalues: CapturedUpvalue[] = [];
        const seen = new Set<string>();

        // Get the set of parameter names (these are not upvalues)
        const paramNames = new Set(node.header.args.map(p => p.name));

        // Walk all QualifiedReference nodes in the lambda body
        const body = node.body ?? node.expr;
        if (!body) return upvalues;

        const refs = AstUtils.streamAllContents(body as AstNode)
            .filter(ast.isQualifiedReference)
            .toArray();

        for (const ref of refs) {
            const target = ref.reference?.ref;
            if (!target) continue;

            if (ast.isFunctionParameter(target) || ast.isVariableDeclSingle(target)) {
                const name = this.getReferenceName(target);

                // Skip if it's a lambda parameter
                if (paramNames.has(name)) continue;

                // Skip if already captured
                if (seen.has(name)) continue;

                // Check if it exists in the current (enclosing) scope
                const varInfo = this.lookupVariable(name);
                if (varInfo) {
                    seen.add(name);
                    upvalues.push({
                        name,
                        register: varInfo.register,
                        type: varInfo.type
                    });
                }
            }
        }

        // Also capture 'this' if used
        if (!seen.has('this')) {
            const thisRefs = AstUtils.streamAllContents(body as AstNode)
                .filter(ast.isThisExpression)
                .toArray();
            if (thisRefs.length > 0) {
                const thisInfo = this.lookupVariable('this');
                if (thisInfo) {
                    upvalues.push({
                        name: 'this',
                        register: thisInfo.register,
                        type: thisInfo.type
                    });
                }
            }
        }

        return upvalues;
    }

    // ============================================================================
    // Pattern Matching
    // ============================================================================

    private visitMatchStatement(node: ast.MatchStatement): void {
        const f = this.func();
        const subject = this.visitExpression(node.target, undefined);
        const endLabel = this.generateLabel('match_end');

        for (let i = 0; i < node.cases.length; i++) {
            const matchCase = node.cases[i];
            const nextCaseLabel = (i < node.cases.length - 1)
                ? this.generateLabel('match_next')
                : endLabel;
            const bodyLabel = this.generateLabel('match_body');

            // Check pattern
            if (matchCase.pattern) {
                this.emitPatternCheck(subject, matchCase.pattern, bodyLabel, nextCaseLabel);
            } else {
                // Default case: always matches
                f.jmp(bodyLabel);
            }

            f.label(bodyLabel);

            // Bind pattern variables (pass nextCaseLabel for nested pattern fail)
            if (matchCase.pattern) {
                this.emitPatternBindings(subject, matchCase.pattern, nextCaseLabel);
            }

            // Execute body
            if (matchCase.body) {
                this.visitBlockStatement(matchCase.body);
            }

            f.jmp(endLabel);

            if (nextCaseLabel !== endLabel) {
                f.label(nextCaseLabel);
            }
        }

        f.label(endLabel);
    }

    private visitMatchExpression(node: ast.MatchExpression): ExpressionResult {
        const f = this.func();
        const subject = this.visitExpression(node.target, undefined);
        const resultReg = this.tmp();
        const resultType = this.getNodeIRType(node);
        const endLabel = this.generateLabel('matchexpr_end');

        f.undef(resultReg, resultType); // Initialize result

        for (let i = 0; i < node.cases.length; i++) {
            const matchCase = node.cases[i];
            const nextCaseLabel = (i < node.cases.length - 1)
                ? this.generateLabel('matchexpr_next')
                : endLabel;
            const bodyLabel = this.generateLabel('matchexpr_body');

            if (matchCase.pattern) {
                this.emitPatternCheck(subject, matchCase.pattern, bodyLabel, nextCaseLabel);
            } else {
                f.jmp(bodyLabel);
            }

            f.label(bodyLabel);

            if (matchCase.pattern) {
                this.emitPatternBindings(subject, matchCase.pattern, nextCaseLabel);
            }

            // Evaluate expression body
            if (matchCase.body) {
                const caseResult = this.visitExpression(matchCase.body, undefined);
                f.mov(resultReg, caseResult.register, resultType);
            }

            f.jmp(endLabel);

            if (nextCaseLabel !== endLabel) {
                f.label(nextCaseLabel);
            }
        }

        f.label(endLabel);
        return { register: resultReg, type: resultType };
    }

    /**
     * Emit pattern check: jumps to matchLabel if pattern matches, failLabel if not
     */
    private emitPatternCheck(
        subject: ExpressionResult,
        pattern: ast.MatchCasePattern,
        matchLabel: string,
        failLabel: string
    ): void {
        const f = this.func();

        if (ast.isLiteralPattern(pattern)) {
            // Compare subject with literal (LiteralPattern IS the literal expression)
            const litResult = this.visitExpression(pattern as unknown as ast.Expression, undefined);
            const cmpReg = this.tmp();
            if (this.isStringIRType(subject.type)) {
                f.cmpEqStr(cmpReg, subject.register, litResult.register);
            } else {
                const cmpType = this.extractCmpType(subject.type, pattern as unknown as AstNode);
                f.cmpEq(cmpReg, subject.register, litResult.register, cmpType);
            }
            f.br(cmpReg, matchLabel, failLabel);
        } else if (ast.isVariablePattern(pattern)) {
            // Variable pattern: always matches, binds in emitPatternBindings
            f.jmp(matchLabel);
        } else if (ast.isWildcardPattern(pattern)) {
            // Wildcard: always matches
            f.jmp(matchLabel);
        } else if (ast.isTypeInstancePattern(pattern)) {
            // Type instance pattern: check variant tag
            const patternTd = this.getType(pattern.type);
            if (isVariantConstructorType(patternTd)) {
                // Read tag from subject
                const tagReg = this.tmp();
                f.structGet(tagReg, subject.register, this.getOrCreateFieldNameId('$tag'), scalarType('u8'));

                // Compare with expected tag
                const expectedTag = this.getVariantConstructorTagFromType(patternTd);
                const expectedTagReg = this.tmp();
                f.constInt(expectedTagReg, expectedTag, 'u8');

                const cmpReg = this.tmp();
                f.cmpEq(cmpReg, tagReg, expectedTagReg, 'u8');
                f.br(cmpReg, matchLabel, failLabel);
            } else if (isClassType(patternTd)) {
                // Class type pattern: check if subject is an instance of this class
                const classTdDesc = patternTd as ClassTypeDescription;
                const classNode = classTdDesc.node;
                const className = classNode && ast.isClassType(classNode) && classNode.$container && ast.isTypeDeclaration(classNode.$container)
                    ? (classNode.$container as ast.TypeDeclaration).name : 'unknown';
                const classId = this.getOrCreateClassUid(className);
                const checkReg = this.tmp();
                f.interfaceIsClass(checkReg, subject.register, classId);
                f.br(checkReg, matchLabel, failLabel);
            } else {
                // Other non-variant type patterns: assume match for now
                f.jmp(matchLabel);
            }
        } else if (ast.isTypePattern(pattern)) {
            // Generic type pattern without type reference
            f.jmp(matchLabel);
        } else {
            // Unknown pattern type: match
            f.jmp(matchLabel);
        }
    }

    /**
     * Emit pattern variable bindings (after pattern check succeeded).
     * For nested patterns, also emits additional checks and branches to failLabel.
     */
    private emitPatternBindings(
        subject: ExpressionResult,
        pattern: ast.MatchCasePattern,
        failLabel?: string
    ): void {
        const f = this.func();

        if (ast.isVariablePattern(pattern)) {
            // Bind subject value to pattern variable
            const varType = subject.type;
            const varReg = this.allocateVariable(pattern.name, varType);
            f.mov(varReg, subject.register, varType);
        } else if (ast.isTypeInstancePattern(pattern)) {
            // If pattern has nested bindings (e.g., Ok(value), Ok(Ok(inner))),
            // bind constructor fields to pattern variables recursively
            const patternTd = this.getType(pattern.type);
            if (isVariantConstructorType(patternTd) && pattern.params) {
                const vcConstructor = patternTd.baseVariant.constructors.find(c => c.name === patternTd.constructorName);
                if (!vcConstructor) {
                    throw new Error(`Variant constructor '${patternTd.constructorName}' not found in variant type`);
                }
                for (let i = 0; i < pattern.params.length; i++) {
                    const nestedPattern = pattern.params[i];
                    const fieldType = this.getVariantFieldType(patternTd, i);
                    const fieldReg = this.tmp();
                    const nameId = this.getOrCreateFieldNameId(vcConstructor.parameters[i].name);
                    f.structGet(fieldReg, subject.register, nameId, fieldType);

                    const fieldSubject: ExpressionResult = { register: fieldReg, type: fieldType };

                    if (ast.isVariablePattern(nestedPattern)) {
                        // Direct binding: allocate variable and move field value
                        const varReg = this.allocateVariable(nestedPattern.name, fieldType);
                        f.mov(varReg, fieldReg, fieldType);
                    } else if (ast.isWildcardPattern(nestedPattern)) {
                        // Wildcard: skip, no binding needed
                    } else if (ast.isLiteralPattern(nestedPattern)) {
                        // Literal: compare field value with literal and branch to fail
                        if (failLabel) {
                            const litResult = this.visitExpression(nestedPattern as unknown as ast.Expression, undefined);
                            const cmpReg = this.tmp();
                            if (this.isStringIRType(fieldType)) {
                                f.cmpEqStr(cmpReg, fieldReg, litResult.register);
                            } else {
                                const cmpType = this.extractCmpType(fieldType, nestedPattern as unknown as AstNode);
                                f.cmpEq(cmpReg, fieldReg, litResult.register, cmpType);
                            }
                            const continueLabel = this.generateLabel('nested_ok');
                            f.br(cmpReg, continueLabel, failLabel);
                            f.label(continueLabel);
                        }
                    } else if (ast.isTypeInstancePattern(nestedPattern)) {
                        // Nested variant pattern: check tag, then recursively bind
                        if (failLabel) {
                            const nestedTd = this.getType(nestedPattern.type);
                            if (isVariantConstructorType(nestedTd)) {
                                const tagReg = this.tmp();
                                f.structGet(tagReg, fieldReg, this.getOrCreateFieldNameId('$tag'), scalarType('u8'));
                                const expectedTag = this.getVariantConstructorTagFromType(nestedTd);
                                const expectedTagReg = this.tmp();
                                f.constInt(expectedTagReg, expectedTag, 'u8');
                                const cmpReg = this.tmp();
                                f.cmpEq(cmpReg, tagReg, expectedTagReg, 'u8');
                                const nestedOkLabel = this.generateLabel('nested_variant_ok');
                                f.br(cmpReg, nestedOkLabel, failLabel);
                                f.label(nestedOkLabel);
                            }
                        }
                        // Recursively bind nested fields
                        this.emitPatternBindings(fieldSubject, nestedPattern, failLabel);
                    } else if (ast.isTypePattern(nestedPattern)) {
                        // Type pattern (without instance check) — recursively bind
                        this.emitPatternBindings(fieldSubject, nestedPattern, failLabel);
                    }
                }
            }
        } else if (ast.isTypePattern(pattern) && pattern.params) {
            // NOTE: This branch is currently unreachable for variant patterns.
            // All variant patterns with params parse as TypeInstancePattern (handled above).
            // TypePattern without TypeInstancePattern only occurs if grammar evolves to allow
            // bare destructuring without a type reference. Kept as defensive fallback.
            for (let i = 0; i < pattern.params.length; i++) {
                const nestedPattern = pattern.params[i];
                // Extract field from subject struct (offset +1 for variant tag)
                const fieldType = this.getNodeIRType(nestedPattern as unknown as AstNode);
                const fieldReg = this.tmp();
                f.structGet(fieldReg, subject.register, i + 1, fieldType);
                const fieldSubject: ExpressionResult = { register: fieldReg, type: fieldType };
                this.emitPatternBindings(fieldSubject, nestedPattern, failLabel);
            }
        }
    }

    // ============================================================================
    // Control Flow Expressions
    // ============================================================================

    private visitConditionalExpression(node: ast.ConditionalExpression): ExpressionResult {
        const f = this.func();
        const resultType = this.getNodeIRType(node);
        const resultReg = this.tmp();
        const endLabel = this.generateLabel('cond_end');

        // Type-C conditional: if cond1 => then1, cond2 => then2, else elseExpr
        // node.value is the subject, conditions[] are conditions, thens[] are results
        // If there's a value, it's `match value { cond1 => then1, ... }`
        // If no conditions but there are thens, it's simple if-then-else

        for (let i = 0; i < node.conditions.length; i++) {
            const condLabel = this.generateLabel('cond_check');
            const thenLabel = this.generateLabel('cond_then');
            const nextLabel = (i < node.conditions.length - 1)
                ? this.generateLabel('cond_next')
                : this.generateLabel('cond_else');

            f.label(condLabel);
            const condResult = this.visitExpression(node.conditions[i], undefined);
            f.br(condResult.register, thenLabel, nextLabel);

            f.label(thenLabel);
            const thenResult = this.visitExpression(node.thens[i], undefined);
            f.mov(resultReg, thenResult.register, resultType);
            f.jmp(endLabel);

            if (i < node.conditions.length - 1) {
                f.label(nextLabel);
            } else {
                // Last condition's else label
                f.label(nextLabel);
                if (node.elseExpr) {
                    const elseResult = this.visitExpression(node.elseExpr, undefined);
                    f.mov(resultReg, elseResult.register, resultType);
                }
                f.jmp(endLabel);
            }
        }

        f.label(endLabel);
        return { register: resultReg, type: resultType };
    }

    private visitLetInExpression(node: ast.LetInExpression): ExpressionResult {
        this.enterScope();

        // Declare let variables
        for (const varDecl of node.vars) {
            if (ast.isVariableDeclSingle(varDecl) && varDecl.initializer) {
                const result = this.visitExpression(varDecl.initializer, undefined);
                const varType = this.getNodeIRType(varDecl);
                const varReg = this.allocateVariable(varDecl.name, varType);
                this.func().mov(varReg, result.register, varType);
            }
        }

        // Evaluate body expression
        const bodyResult = this.visitExpression(node.expr, undefined);

        this.exitScope();
        return bodyResult;
    }

    private visitDoExpression(node: ast.DoExpression): ExpressionResult {
        // Execute block, last expression statement's value is the result
        const resultType = this.getNodeIRType(node);
        const resultReg = this.tmp();
        this.func().undef(resultReg, resultType);

        this.enterScope();
        const stmts = node.body.statements;
        for (let i = 0; i < stmts.length; i++) {
            const stmt = stmts[i];
            if (i === stmts.length - 1 && ast.isExpressionStatement(stmt)) {
                // Last statement - capture as result
                const result = this.visitExpression(stmt.expr, undefined);
                this.func().mov(resultReg, result.register, resultType);
            } else {
                this.visitStatement(stmt);
            }
        }
        this.exitScope();

        return { register: resultReg, type: resultType };
    }

    // ============================================================================
    // Special Expressions
    // ============================================================================

    private visitThisExpression(): ExpressionResult {
        const thisInfo = this.lookupVariable('this');
        if (thisInfo) {
            return { register: thisInfo.register, type: thisInfo.type };
        }
        return { register: 'this', type: ptrType('class') };
    }

    private visitThrowExpression(node: ast.ThrowExpression): ExpressionResult {
        const expr = this.visitExpression(node.expr, undefined);
        this.func().throw(expr.register);
        const temp = this.tmp();
        this.func().undef(temp, voidType());
        return { register: temp, type: voidType() };
    }

    private visitYieldExpression(node: ast.YieldExpression): ExpressionResult {
        if (node.expr) {
            const expr = this.visitExpression(node.expr, undefined);
            this.func().coroYield([expr.register], [expr.type]);
        } else {
            this.func().coroYield([], []);
        }
        // After yield, the coroutine resumes and the result comes back
        const temp = this.tmp();
        const resultType = this.getNodeIRType(node);
        this.func().undef(temp, resultType);
        return { register: temp, type: resultType };
    }

    private visitCoroutineExpression(node: ast.CoroutineExpression): ExpressionResult {
        const temp = this.tmp();
        const funcExpr = this.visitExpression(node.fn, undefined);
        // Coroutine instances are created from callable values (closures), which
        // covers named functions, lambdas, and captured environments uniformly.
        this.func().coroAllocFrom(temp, funcExpr.register);
        return { register: temp, type: ptrType('coroutine') };
    }

    private visitTupleExpression(node: ast.TupleExpression): ExpressionResult {
        if (node.expressions.length === 1) {
            // Single element tuple = unwrap (parenthesized expression)
            return this.visitExpression(node.expressions[0], undefined);
        }

        // Multi-element: visit first element as representative return
        // Tuple returns are handled at the call site
        if (node.expressions.length > 0) {
            return this.visitExpression(node.expressions[0], undefined);
        }

        const temp = this.tmp();
        this.func().undef(temp, voidType());
        return { register: temp, type: voidType() };
    }

    // ============================================================================
    // Type Operations
    // ============================================================================

    private visitInstanceCheckExpression(node: ast.InstanceCheckExpression): ExpressionResult {
        const f = this.func();
        const expr = this.visitExpression(node.left, undefined);
        const temp = this.tmp();

        // Resolve the target type
        const targetTd = this.getType(node.destType);
        const resolvedTarget = isReferenceType(targetTd) ? this.typeUtils.resolveIfReference(targetTd) : targetTd;

        if (resolvedTarget.kind === TypeKind.Null) {
            f.isNull(temp, expr.register);
            return { register: temp, type: scalarType('bool') };
        }

        if (isVariantConstructorType(resolvedTarget)) {
            // Variant constructor: check tag field
            const vcTd = resolvedTarget as VariantConstructorTypeDescription;
            const tagReg = this.tmp();
            f.structGet(tagReg, expr.register, this.getOrCreateFieldNameId('$tag'), scalarType('u8'));
            const expectedTag = this.getVariantConstructorTagFromType(vcTd);
            const expectedTagReg = this.tmp();
            f.constInt(expectedTagReg, expectedTag, 'u8');
            f.cmpEq(temp, tagReg, expectedTagReg, 'u8');
            return { register: temp, type: scalarType('bool') };
        }

        // Class: use interface_is_class
        let classId = 0;
        if (isClassType(resolvedTarget)) {
            const classDesc = resolvedTarget as ClassTypeDescription;
            const classNode = classDesc.node;
            const className = classNode && ast.isClassType(classNode) && classNode.$container && ast.isTypeDeclaration(classNode.$container)
                ? (classNode.$container as ast.TypeDeclaration).name : '';
            classId = this.getOrCreateClassUid(className);
        }

        f.interfaceIsClass(temp, expr.register, classId);
        return { register: temp, type: scalarType('bool') };
    }

    private visitTypeCastExpression(node: ast.TypeCastExpression): ExpressionResult {
        const expr = this.visitExpression(node.left, undefined);
        const temp = this.tmp();
        const targetType = this.convertTypeWithSubstitution(node.destType);

        // Determine cast kind
        if (isScalar(expr.type) && isScalar(targetType)) {
            const srcScalar = (expr.type as ScalarIRType).scalar;
            const tgtScalar = (targetType as ScalarIRType).scalar;

            if (srcScalar === tgtScalar) {
                // No-op cast
                this.func().mov(temp, expr.register, targetType);
            } else if (isInteger(expr.type) && isInteger(targetType)) {
                // Int-to-int:
                // - same signedness -> widen/narrow by size
                // - different signedness -> explicit signed/unsigned cast
                const srcType = srcScalar as IntType;
                const tgtType = tgtScalar as IntType;
                const srcSize = this.intTypeSize(srcType);
                const tgtSize = this.intTypeSize(tgtType);
                const sameSignedness = (srcType.startsWith('i') && tgtType.startsWith('i')) ||
                    (srcType.startsWith('u') && tgtType.startsWith('u'));

                if (!sameSignedness) {
                    const castKind: CastKind = srcType.startsWith('i') ? 'i_u' : 'u_i';
                    this.func().cast(temp, expr.register, castKind);
                } else if (tgtSize > srcSize) {
                    this.func().widen(temp, expr.register, srcType, tgtType);
                } else {
                    if (srcSize === 8) {
                        this.func().narrow(temp, expr.register, srcType, tgtType);
                    } else {
                        const widenedType: IntType = srcType.startsWith('i') ? 'i64' : 'u64';
                        const widenedReg = this.tmp();
                        this.func().widen(widenedReg, expr.register, srcType, widenedType);
                        this.func().narrow(temp, widenedReg, widenedType, tgtType);
                    }
                }
            } else if (isInteger(expr.type) && (isFloat(targetType) || isDouble(targetType))) {
                const castKind: CastKind = isSignedInt(expr.type)
                    ? (isFloat(targetType) ? 'i_f' : 'i_d')
                    : (isFloat(targetType) ? 'u_f' : 'u_d');
                this.func().cast(temp, expr.register, castKind);
            } else if ((isFloat(expr.type) || isDouble(expr.type)) && isInteger(targetType)) {
                const castKind: CastKind = isSignedInt(targetType)
                    ? (isFloat(expr.type) ? 'f_i' : 'd_i')
                    : (isFloat(expr.type) ? 'f_u' : 'd_u');
                this.func().cast(temp, expr.register, castKind);
            } else if (isFloat(expr.type) && isDouble(targetType)) {
                this.func().cast(temp, expr.register, 'f_d');
            } else if (isDouble(expr.type) && isFloat(targetType)) {
                this.func().cast(temp, expr.register, 'd_f');
            } else {
                this.func().mov(temp, expr.register, targetType);
            }
        } else {
            // Pointer cast: check for variant safe cast (as?)
            const targetTd = this.getType(node.destType);
            const resolvedTargetTd = isReferenceType(targetTd) ? this.typeUtils.resolveIfReference(targetTd) : targetTd;

            if (node.castType === 'as?' && isVariantConstructorType(resolvedTargetTd)) {
                // Safe cast to variant constructor: check tag, return null on mismatch
                const f = this.func();
                const vcTd = resolvedTargetTd as VariantConstructorTypeDescription;
                const tagReg = this.tmp();
                f.structGet(tagReg, expr.register, this.getOrCreateFieldNameId('$tag'), scalarType('u8'));
                const expectedTag = this.getVariantConstructorTagFromType(vcTd);
                const expectedTagReg = this.tmp();
                f.constInt(expectedTagReg, expectedTag, 'u8');
                const cmpReg = this.tmp();
                f.cmpEq(cmpReg, tagReg, expectedTagReg, 'u8');
                const okLabel = this.generateLabel('safe_cast_ok');
                const nullLabel = this.generateLabel('safe_cast_null');
                const endLabel = this.generateLabel('safe_cast_end');
                f.br(cmpReg, okLabel, nullLabel);
                f.label(okLabel);
                f.mov(temp, expr.register, targetType);
                f.jmp(endLabel);
                f.label(nullLabel);
                f.constNull(temp);
                f.label(endLabel);
            } else {
                // Regular pointer cast: just mov
                this.func().mov(temp, expr.register, targetType);
            }
        }

        return { register: temp, type: targetType };
    }

    private visitDenullExpression(node: ast.DenullExpression): ExpressionResult {
        const f = this.func();
        const expr = this.visitExpression(node.expr, undefined);
        const temp = this.tmp();
        const nullCheck = this.tmp();
        const okLabel = this.generateLabel('denull_ok');
        const failLabel = this.generateLabel('denull_fail');

        f.isNull(nullCheck, expr.register);
        f.br(nullCheck, failLabel, okLabel);

        f.label(failLabel);
        // Throw on null
        const errMsg = this.tmp();
        f.strConst(errMsg, "Null dereference");
        f.throw(errMsg);

        f.label(okLabel);
        f.mov(temp, expr.register, expr.type);

        return { register: temp, type: expr.type };
    }

    // ---- Index Set Expression ----

    private visitIndexSet(node: ast.IndexSet): ExpressionResult {
        const f = this.func();
        const obj = this.visitExpression(node.expr, undefined);
        const value = this.visitExpression(node.value, undefined);

        // Check for []= operator overload
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const baseObjTd = isNullableType(resolvedObjTd) ? resolvedObjTd.baseType : resolvedObjTd;
        if (node.indexes && node.indexes.length > 0) {
            const indexResults = node.indexes.map(idx => this.visitExpression(idx, undefined));
            const indexTds = node.indexes.map(idx => this.getType(idx));
            const valueTd = this.getType(node.value);
            const allArgTds = [...indexTds, valueTd];
            const overload = this.resolveOperatorMethod(objTd, '[]=', allArgTds);
            if (overload) {
                const allArgRegs = [...indexResults.map(r => r.register), value.register];
                const allArgIRTypes = [...indexResults.map(r => r.type), value.type];
                return this.emitOperatorCall(
                    obj, overload.methodId, overload.returnType,
                    allArgRegs, allArgIRTypes
                );
            }

            if (!isArrayType(baseObjTd)) {
                throw new Error(
                    `Index assignment lowering failed for non-array type '${baseObjTd.toString()}': no '[]=' overload found`
                );
            }
            // Primitive array set
            f.arraySet(obj.register, indexResults[0].register, value.register, value.type);
        }

        return value;
    }

    // ---- Reverse Index Access ----

    private visitReverseIndexAccess(node: ast.ReverseIndexAccess): ExpressionResult {
        const f = this.func();
        const obj = this.visitExpression(node.expr, undefined);
        const index = this.visitExpression(node.index, undefined);

        // Check for [-] operator overload
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const baseObjTd = isNullableType(resolvedObjTd) ? resolvedObjTd.baseType : resolvedObjTd;
        const indexTd = this.getType(node.index);
        const overload = this.resolveOperatorMethod(objTd, '[-]', [indexTd]);
        if (overload) {
            return this.emitOperatorCall(
                obj, overload.methodId, overload.returnType,
                [index.register], [index.type]
            );
        }

        if (!isArrayType(baseObjTd)) {
            throw new Error(
                `Reverse index access lowering failed for non-array type '${baseObjTd.toString()}': no '[-]' overload found`
            );
        }
        // Primitive: compute arr[arr.length - index]
        // Grammar parses arr[-1] as index=1, so length-1 = last element
        const temp = this.tmp();
        const lenReg = this.tmp();
        const realIdx = this.tmp();
        const elemType = this.getNodeIRType(node);

        f.arrayLength(lenReg, obj.register);
        f.sub(realIdx, lenReg, index.register, 'u64');
        f.arrayGet(temp, obj.register, realIdx, elemType);

        return { register: temp, type: elemType };
    }

    // ---- Reverse Index Set ----

    private visitReverseIndexSet(node: ast.ReverseIndexSet): ExpressionResult {
        const f = this.func();
        const obj = this.visitExpression(node.expr, undefined);
        const index = this.visitExpression(node.index, undefined);
        const value = this.visitExpression(node.value, undefined);

        // Check for [-]= operator overload
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const baseObjTd = isNullableType(resolvedObjTd) ? resolvedObjTd.baseType : resolvedObjTd;
        const indexTd = this.getType(node.index);
        const valueTd = this.getType(node.value);
        const overload = this.resolveOperatorMethod(objTd, '[-]=', [indexTd, valueTd]);
        if (overload) {
            return this.emitOperatorCall(
                obj, overload.methodId, overload.returnType,
                [index.register, value.register], [index.type, value.type]
            );
        }

        if (!isArrayType(baseObjTd)) {
            throw new Error(
                `Reverse index assignment lowering failed for non-array type '${baseObjTd.toString()}': no '[-]=' overload found`
            );
        }
        // Primitive: arr[arr.length - index] = value
        // Grammar parses arr[-1] as index=1, so length-1 = last element
        const lenReg = this.tmp();
        const realIdx = this.tmp();

        f.arrayLength(lenReg, obj.register);
        f.sub(realIdx, lenReg, index.register, 'u64');
        f.arraySet(obj.register, realIdx, value.register, value.type);

        return value;
    }

    // ---- Object Update ----

    private visitObjectUpdate(node: ast.ObjectUpdate): ExpressionResult {
        const f = this.func();
        const obj = this.visitExpression(node.expr, undefined);
        const objTd = this.getType(node.expr);
        const resolvedObjTd = isReferenceType(objTd) ? this.typeUtils.resolveIfReference(objTd) : objTd;
        const resultType = this.getNodeIRType(node);

        // Clone the struct/class then set the updated fields
        if (isStructType(resolvedObjTd) || isVariantType(resolvedObjTd) || isVariantConstructorType(resolvedObjTd)) {
            const shapeId = this.getOrDeclareStructShape(resolvedObjTd);
            const clone = this.tmp();
            // Allocate a new struct and copy fields
            f.structAlloc(clone, shapeId);

            // Copy all fields from original
            const structTd = resolvedObjTd as StructTypeDescription;
            for (let i = 0; i < structTd.fields.length; i++) {
                const fieldType = this.convertTypeDescriptionToIR(structTd.fields[i].type);
                const nameId = this.getOrCreateFieldNameId(structTd.fields[i].name);
                const fieldVal = this.tmp();
                f.structGet(fieldVal, obj.register, nameId, fieldType);
                f.structSet(clone, nameId, fieldVal, fieldType);
            }

            // Override with updated fields
            for (const pair of node.pairs) {
                const fieldIndex = this.getStructFieldIndex(resolvedObjTd, pair.name);
                const newValue = this.visitExpression(pair.expr, undefined);
                f.structSet(clone, fieldIndex, newValue.register, newValue.type);
            }

            return { register: clone, type: resultType };
        }

        if (isClassType(resolvedObjTd)) {
            // For classes, update fields on the object directly (or clone if immutable)
            // For now, create a simple update pattern
            for (const pair of node.pairs) {
                const fieldIndex = this.getClassFieldIndex(resolvedObjTd, pair.name);
                const newValue = this.visitExpression(pair.expr, undefined);
                f.classSet(obj.register, fieldIndex, newValue.register, newValue.type);
            }
            return obj;
        }

        // Fallback
        return obj;
    }

    // ---- Wildcard Expression ----

    private visitWildcardExpression(): ExpressionResult {
        // Wildcard (_) — produces an undefined/unused value
        const temp = this.tmp();
        this.func().undef(temp, voidType());
        return { register: temp, type: voidType() };
    }

    // ---- Unreachable Expression ----

    private visitUnreachableExpression(): ExpressionResult {
        const f = this.func();
        const errMsg = this.tmp();
        f.strConst(errMsg, "Unreachable code reached");
        f.throw(errMsg);
        // Return void — should never actually be used
        const temp = this.tmp();
        f.undef(temp, voidType());
        return { register: temp, type: voidType() };
    }

    // ---- Mutate Expression ----

    private visitMutateExpression(node: ast.MutateExpression): ExpressionResult {
        // `mutate expr` — evaluate the expression (the mutation is a semantic marker)
        // At the IR level, this is just the expression itself since the compiler
        // tracks mutability at the type level, not the IR level
        return this.visitExpression(node.expr, undefined);
    }

    // ---- Binary String Literal ----

    private visitBinaryStringLiteral(node: ast.BinaryStringLiteralExpression): ExpressionResult {
        const f = this.func();
        const temp = this.tmp();
        // Binary strings (b"...") are arrays of u8
        const bytes = node.value;
        const sizeReg = this.tmp();
        f.constInt(sizeReg, bytes.length, 'u64');
        f.arrayAlloc(temp, scalarType('u8'), sizeReg);

        // Fill in each byte
        for (let i = 0; i < bytes.length; i++) {
            const byteReg = this.tmp();
            const idxReg = this.tmp();
            f.constInt(byteReg, bytes.charCodeAt(i), 'u8');
            f.constInt(idxReg, i, 'u64');
            f.arraySet(temp, idxReg, byteReg, scalarType('u8'));
        }

        return { register: temp, type: ptrType('array') };
    }

    // ============================================================================
    // Shape & Field Helpers
    // ============================================================================

    /** Cache for struct shape IDs based on structural identity */
    private structShapeCache = new Map<string, string>();

    private getOrDeclareStructShape(td: TypeDescription): string {
        // Generate a deterministic key from the type's field names and types
        const structKey = this.computeStructTypeKey(td);
        const cached = this.structShapeCache.get(structKey);
        if (cached) return cached;

        const id = `struct_${this.structShapeCounter++}`;
        this.structShapeCache.set(structKey, id);

        if (isStructType(td)) {
            const shape = {
                id,
                fields: (td as StructTypeDescription).fields.map((field) => ({
                    globalFieldId: this.getOrCreateFieldNameId(field.name),
                    type: this.convertTypeDescriptionToIR(field.type),
                    name: field.name
                }))
            };
            this.program.declareStruct(shape);
            return id;
        }
        if (isVariantConstructorType(td)) {
            const vcTd = td as VariantConstructorTypeDescription;
            const constructor = vcTd.baseVariant.constructors.find(c => c.name === vcTd.constructorName);
            const fields: { globalFieldId: number; type: IRType; name: string }[] = [
                { globalFieldId: this.getOrCreateFieldNameId('$tag'), type: scalarType('u8'), name: '$tag' }
            ];
            if (constructor?.parameters) {
                for (let i = 0; i < constructor.parameters.length; i++) {
                    const param = constructor.parameters[i];
                    const fieldType = this.substituteVariantFieldType(vcTd, i);
                    fields.push({
                        globalFieldId: this.getOrCreateFieldNameId(param.name),
                        type: this.convertTypeDescriptionToIR(fieldType),
                        name: param.name
                    });
                }
            }
            this.program.declareStruct({ id, fields });
            return id;
        }
        // Fallback: declare empty shape
        this.program.declareStruct({ id, fields: [] });
        return id;
    }

    /**
     * Compute a structural key for a type to enable shape deduplication.
     * Two structurally identical types will produce the same key.
     */
    private computeStructTypeKey(td: TypeDescription): string {
        if (isStructType(td)) {
            const structTd = td as StructTypeDescription;
            const fields = structTd.fields
                .map(f => `${f.name}:${serializeIRType(this.convertTypeDescriptionToIR(f.type))}`)
                .join(',');
            return `struct{${fields}}`;
        }
        if (isVariantConstructorType(td)) {
            const vcTd = td as VariantConstructorTypeDescription;
            const constructor = vcTd.baseVariant.constructors.find(c => c.name === vcTd.constructorName);
            const fields = constructor?.parameters
                ?.map((p, i) => `${p.name}:${serializeIRType(this.convertTypeDescriptionToIR(
                    this.substituteVariantFieldType(vcTd, i)
                ))}`)
                .join(',') ?? '';
            return `vc_${vcTd.constructorName}{$tag:u8,${fields}}`;
        }
        if (isVariantType(td)) {
            const vTd = td as { constructors: readonly { name: string }[] };
            return `variant_${vTd.constructors.map(c => c.name).join('|')}`;
        }
        throw new Error(`Unhandled type in computeStructTypeKey: ${td.kind}`);
    }

    private getStructFieldIndex(td: TypeDescription, fieldName: string): number {
        if (isStructType(td) || isVariantConstructorType(td)) {
            return this.getOrCreateFieldNameId(fieldName);
        }
        return 0;
    }

    private getClassFieldIndex(td: TypeDescription, fieldName: string): number {
        if (isClassType(td)) {
            const idx = (td as ClassTypeDescription).attributes.findIndex(a => a.name === fieldName);
            return idx >= 0 ? idx : 0;
        }
        return 0;
    }

    private getClassShapeKey(node: ast.NewExpression): string {
        const refType = node.instanceType;
        if (refType && ast.isReferenceType(refType)) {
            const classDecl = refType.field?.ref;
            if (classDecl && ast.isTypeDeclaration(classDecl)) {
                const className = this.classNodeToIRName.get(classDecl) || classDecl.name;
                return `class_${className}`;
            }
        }
        // Should not happen for valid class references
        throw new Error(`Cannot resolve class shape key for NewExpression`);
    }

    private getMethodId(td: TypeDescription, methodName: string): number {
        // Use global method name ID for coloring — same name always gets same ID
        return this.getOrCreateMethodNameId(methodName);
    }

    private getVariantConstructorTag(constructorRef: ast.VariantConstructor): number {
        const variantType = constructorRef.$container;
        if (ast.isVariantType(variantType)) {
            return variantType.constructors.indexOf(constructorRef);
        }
        return 0;
    }

    private getVariantConstructorTagFromType(td: VariantConstructorTypeDescription): number {
        const baseVariant = td.baseVariant;
        const name = td.constructorName;
        const idx = baseVariant.constructors.findIndex(c => c.name === name);
        return idx >= 0 ? idx : 0;
    }

    private getVariantFieldType(td: VariantConstructorTypeDescription, fieldIndex: number): IRType {
        return this.convertTypeDescriptionToIR(this.substituteVariantFieldType(td, fieldIndex));
    }

    /**
     * Get the substituted type for a variant constructor field.
     * Applies generic substitution from the constructor's genericArgs.
     */
    private substituteVariantFieldType(td: VariantConstructorTypeDescription, fieldIndex: number): TypeDescription {
        const constructor = td.baseVariant.constructors.find(c => c.name === td.constructorName);
        if (!constructor?.parameters || fieldIndex >= constructor.parameters.length) {
            return { kind: TypeKind.Void } as TypeDescription;
        }
        const rawType = constructor.parameters[fieldIndex].type;
        if (!td.genericArgs || td.genericArgs.length === 0) return rawType;
        const variantDecl = td.variantDeclaration;
        if (!variantDecl?.genericParameters || variantDecl.genericParameters.length === 0) return rawType;
        const subs = new Map<string, TypeDescription>();
        for (let i = 0; i < variantDecl.genericParameters.length && i < td.genericArgs.length; i++) {
            subs.set(variantDecl.genericParameters[i].name, td.genericArgs[i]);
        }
        return this.typeUtils.substituteGenerics(rawType, subs);
    }

    private intTypeSize(t: IntType): number {
        switch (t) {
            case 'i8': case 'u8': return 1;
            case 'i16': case 'u16': return 2;
            case 'i32': case 'u32': return 4;
            case 'i64': case 'u64': return 8;
        }
    }
}
