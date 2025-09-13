import {
  AstNode,
  AstUtils,
  DocumentCache,
  DocumentState,
  IndexManager,
} from "langium";
import { LangiumServices } from "langium/lsp";
import * as ast from "../generated/ast.js";
import { createAnyType } from "./datatypes/any-type.js";
import {
  ArrayTypeDescription,
  createArrayType,
  isDescArrayType,
} from "./datatypes/array-type.js";
import { createBoolType } from "./datatypes/bool-type.js";
import {
  ClassMethodDescription,
  ClassTypeDescription,
  createClassAttributeDescription,
  createClassDefinitionType,
  createClassMethodDescription,
  createClassType,
  isDescClassDefinitionType,
  isDescClassType,
} from "./datatypes/class-type.js";
import { createCoroutineType } from "./datatypes/coroutine-type.js";
import {
  createEnumCaseDescription,
  createEnumType,
  isDescEnumType,
} from "./datatypes/enum-type.js";
import { createErrorType } from "./datatypes/error-type.js";
import {
  createFFIDefinitionType,
  isDescFFIDefinitionType,
} from "./datatypes/ffi-type.js";
import { createFloatType } from "./datatypes/float-type.js";
import {
  createFunctionParameterDescription,
  createFunctionType,
  FunctionTypeDescription,
  isDescFunctionType,
} from "./datatypes/function-type.js";
import { createIntegerType } from "./datatypes/integer-type.js";
import {
  createInterfaceMethodDescription,
  createInterfaceType,
  InterfaceMethodDescription,
  InterfaceTypeDescription,
  isDescInterfaceType,
} from "./datatypes/interface-type.js";
import {
  createNamespaceDefinitionType,
  isDescNamespaceDefinitionType,
} from "./datatypes/namespace-type.js";
import { createNullType } from "./datatypes/null-type.js";
import { isDescNullableType } from "./datatypes/nullable-type.js";
import { createStringType } from "./datatypes/string-type.js";
import {
  createStructFieldDescription,
  createStructType,
  isDescStructType,
} from "./datatypes/struct-type.js";
import { createTupleType } from "./datatypes/tuple-type.js";
import { createVariantConstructorType } from "./datatypes/variant-consturctor-type.js";
import {
  createVariantDefinitionType,
  createVariantType,
  isDescVariantDefinitionType,
  VariantTypeDescription,
} from "./datatypes/variant-type.js";
import { createVoidType } from "./datatypes/void-type.js";
import { TypeDescription } from "./type-c-types.js";
import { getMinStorageForInt } from "./type-utils.js";
import { prototypeURI } from "../builtins/index.js";
import { createGenericType } from "./datatypes/generic-type.js";

export type NamedAstNode = AstNode & { name: string };

export class TypeCTypeProvider {
  // a cache of the .inferType() results
  private readonly typeCache: DocumentCache<AstNode, TypeDescription>;
  private readonly expectedTypeCache: DocumentCache<AstNode, TypeDescription>;
  private readonly typeCreationCache: DocumentCache<AstNode, TypeDescription>;
  private readonly indexManager: IndexManager;

  constructor(services: LangiumServices) {
    this.typeCache = new DocumentCache(
      services.shared,
      DocumentState.IndexedContent
    );
    this.expectedTypeCache = new DocumentCache(
      services.shared,
      DocumentState.IndexedContent
    );
    this.typeCreationCache = new DocumentCache(
      services.shared,
      DocumentState.IndexedContent
    );
    this.indexManager = services.shared.workspace.IndexManager;
  }

  private getNodeUri(node: AstNode): string {
    return AstUtils.getDocument(node).uri.toString();
  }

  inferType(node: AstNode | undefined): TypeDescription {
    if (!node) {
      return createErrorType(`Cannot infer type of undefined node`, node);
    }

    // check the cache first
    const uri = this.getNodeUri(node);
    const cachedType = this.typeCache.get(uri, node);
    if (cachedType) {
      return cachedType;
    }

    let nodeType: TypeDescription = createErrorType(
      `Circular type inference`,
      node
    );
    // save the result to the cache
    this.typeCache.set(uri, node, nodeType);

    if (ast.isQualifiedReference(node)) {
      nodeType = this.inferQualifiedReference(node);
    } else if (ast.isFunctionParameter(node)) {
      nodeType = this.createTypeFromNode(node.type);
    } else if (ast.isExpression(node)) {
      nodeType = this.inferExpression(node);
    } else if (ast.isStructField(node)) {
      nodeType = this.createTypeFromNode(node.type);
    } else if (ast.isClassAttributeDecl(node)) {
      nodeType = this.createTypeFromNode(node.type);
    } else if (ast.isVariableDeclSingle(node)) {
      if (node.annotation) {
        nodeType = this.createTypeFromNode(node.annotation);
      } else {
        nodeType = this.inferExpression(node.initializer);
      }
    } else if (ast.isFunctionParameter(node)) {
      nodeType = this.createTypeFromNode(node);
    } else if (ast.isDataType(node)) {
      nodeType = this.createTypeFromNode(node);
    } else if (ast.isVariantConstructor(node)) {
      nodeType = this.createTypeFromNode(node);
    } else if (ast.isQualifiedReference(node)) {
      nodeType = this.inferQualifiedReference(node);
    } else if (ast.isNamespaceDecl(node)) {
      nodeType = createNamespaceDefinitionType(node.name, node);
    } else if (ast.isExternFFIDecl(node)) {
      nodeType = createFFIDefinitionType(node.name, node);
    } else if (ast.isTypeDeclaration(node)) {
      // We need to find the root of the type definition but still need the name of the type
      // to create the proper type definition
      const typeRoot = this.findTypeRoot(node);
      if (typeRoot) {
        if (ast.isVariantType(typeRoot)) {
          nodeType = createVariantDefinitionType(
            node.name,
            this.createTypeFromNode(typeRoot) as VariantTypeDescription
          );
        } else if (ast.isClassType(typeRoot)) {
          nodeType = createClassDefinitionType(
            node.name,
            this.createTypeFromNode(typeRoot) as ClassTypeDescription
          );
        } else {
          nodeType = createErrorType(`???`, node);
        }
      } else {
        nodeType = createErrorType(`Incomplete type definition`, node);
      }
    } else {
      nodeType = this.createTypeFromNode(node);
    }

    this.typeCache.set(uri, node, nodeType);
    return nodeType;
  }

  inferExpression(node: ast.Expression): TypeDescription {
    if (!node.$type) {
      return createErrorType(`Incomplete expression`, node);
    }

    if (ast.isTupleExpression(node)) {
      return this.inferTupleExpression(node);
    } else if (ast.isConditionalExpression(node)) {
      return this.inferConditionalExpression(node);
    } else if (ast.isMatchExpression(node)) {
      return this.inferMatchExpression(node);
    } else if (ast.isLetInExpression(node)) {
      return this.inferLetInExpression(node);
    } else if (ast.isBinaryExpression(node)) {
      return this.inferBinaryExpression(node);
    } else if (ast.isUnaryExpression(node)) {
      return this.inferUnaryExpression(node);
    } else if (ast.isThrowExpression(node)) {
      return this.inferThrowExpression(node);
    } else if (ast.isMutateExpression(node)) {
      return this.inferMutateExpression(node);
    } else if (ast.isCoroutineExpression(node)) {
      return this.inferCoroutineExpression(node);
    } else if (ast.isYieldExpression(node)) {
      return this.inferYieldExpression(node);
    } else if (ast.isNewExpression(node)) {
      return this.inferNewExpression(node);
    } else if (ast.isInstanceCheckExpression(node)) {
      return this.inferInstanceCheckExpression(node);
    } else if (ast.isTypeCastExpression(node)) {
      return this.inferTypeCastExpression(node);
    } else if (ast.isMemberAccess(node)) {
      return this.inferMemberAccess(node);
    } else if (ast.isFunctionCall(node)) {
      return this.inferFunctionCall(node);
    } else if (ast.isReverseIndexSet(node)) {
      return this.inferReverseIndexSet(node);
    } else if (ast.isReverseIndexAccess(node)) {
      return this.inferReverseIndexAccess(node);
    } else if (ast.isIndexSet(node)) {
      return this.inferIndexSet(node);
    } else if (ast.isIndexAccess(node)) {
      return this.inferIndexAccess(node);
    } else if (ast.isPostfixOp(node)) {
      return this.inferPostfixOp(node);
    } else if (ast.isDenullExpression(node)) {
      return this.inferDenullExpression(node);
    } else if (ast.isLiteralExpression(node)) {
      return this.inferLiteralExpression(node);
    } else if (ast.isLambdaExpression(node)) {
      return this.inferLambdaExpression(node);
    } else if (ast.isDoExpression(node)) {
      return this.inferDoExpression(node);
    } else if (ast.isThisExpression(node)) {
      return this.inferThisExpression(node);
    } else if (ast.isGenericReferenceExpr(node)) {
      return this.inferGenericReferenceExpr(node);
    } else if (ast.isQualifiedReference(node)) {
      return this.inferQualifiedReference(node);
    } else if (ast.isArrayConstructionExpression(node)) {
      return this.inferArrayConstructionExpression(node);
    } else if (ast.isNamedStructConstructionExpression(node)) {
      return this.inferNamedStructConstructionExpression(node);
    } else if (ast.isAnonymousStructConstructionExpression(node)) {
      return this.inferAnonymousStructConstructionExpression(node);
    }

    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferLetInExpression(node: ast.LetInExpression): TypeDescription {
    // we infer the .expr
    return this.inferExpression(node.expr);
  }

  inferBinaryExpression(node: ast.BinaryExpression): TypeDescription {
    // Whe infer the LHS first, because Type-C supports operator overload.
    // The LHS will directly influence the type of the binary expression itself.

    const lhsType = this.inferExpression(node.left);
    //const _rhsType = this.inferExpression(node.right);

    // TODO: implement
    return lhsType;
  }

  inferUnaryExpression(node: ast.UnaryExpression): TypeDescription {
    return this.inferExpression(node.expr);
  }

  inferThrowExpression(node: ast.ThrowExpression): TypeDescription {
    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferMutateExpression(node: ast.MutateExpression): TypeDescription {
    return this.inferExpression(node.expr);
  }

  inferCoroutineExpression(node: ast.CoroutineExpression): TypeDescription {
    const fn = this.inferExpression(node.fn);
    if (isDescFunctionType(fn)) {
      return createCoroutineType(fn);
    }

    return createErrorType(
      `Expected a function type, got \`${fn.$type}\``,
      node
    );
  }

  inferYieldExpression(node: ast.YieldExpression): TypeDescription {
    return node.expr ? this.inferExpression(node.expr) : createVoidType();
  }

  inferNewExpression(node: ast.NewExpression): TypeDescription {
    // we can have x: Array = new ([1, 2, 3])
    return node.instanceType
      ? this.createTypeFromNode(node.instanceType)
      : createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferInstanceCheckExpression(
    node: ast.InstanceCheckExpression
  ): TypeDescription {
    return createBoolType();
  }

  inferTypeCastExpression(node: ast.TypeCastExpression): TypeDescription {
    return this.createTypeFromNode(node.destType);
  }

  /*
    inferMemberAccessCall(node: ast.MemberAccessCall): TypeDescription {
        // We have a lot of options here:
        // 1. Namespace attribute/function call: Math.abs(1)
        // 2. Variant Consturctor call: Response.Error(200)
        // 3. Static Class method call JSON.parse("{x: 1}")
        // 4. FFI function call: cstdlib.malloc(10)
        // 5. Class method call: obj.free()
        // 6. Class attribute call: obj.attribute()
        // 7. Interface method call: interfaceObj.abs(1)
        // 8. Struct field call: aStruct.x()
        
        // start with cases 1, 2, 3 and 4
        if(ast.isQualifiedReference(node.expr)) {
            // check if it is a namespace attribute/function call
            if(ast.isNamespaceDecl(node.expr.ref)) {
                // check if it is a namespace
                // TODO: implement
                return createErrorType(`Not implemented: resolving namespace attribute/function call`, node);
            }

            if(ast.isTypeDeclaration(node.expr.ref)) {
                // check if it is a type declaration
                // TODO: implement
                return createErrorType(`Not implemented: resolving type declaration`, node);
            }

            if(ast.isClassType(node.expr.ref)) {
                // check if it is a class attribute/method call
                // TODO: implement
                return createErrorType(`Not implemented: resolving class attribute/method call`, node);
            }

            if(ast.isInterfaceType(node.expr.ref)) {
                // check if it is a interface method call
                // TODO: implement
                return createErrorType(`Not implemented: resolving interface method call`, node);
            }
            
            
            
            
        }

        
        const baseExprType = this.inferExpression(node.expr);
        
        if(isDescClassType(baseExprType)) {
        }
        else if (isDescInterfaceType(baseExprType)) {
        } 
    }
    */

  inferFunctionCall(node: ast.FunctionCall): TypeDescription {
    const fnType = this.inferExpression(node.expr);
    if (isDescFunctionType(fnType)) {
      if (fnType.returnType) {
        return fnType.returnType;
      }
      return createVoidType();
    }

    return createErrorType(
      `Expected a function type, got \`${fnType.$type}\``,
      node
    );
  }

  inferReverseIndexSet(node: ast.ReverseIndexSet): TypeDescription {
    return this.inferExpression(node.value);
  }

  inferReverseIndexAccess(node: ast.ReverseIndexAccess): TypeDescription {
    const baseExprType = this.inferExpression(node.expr);
    if (isDescArrayType(baseExprType)) {
      return baseExprType.elementType;
    }

    return createErrorType(
      `Expected an array type, got \`${baseExprType.$type}\``,
      node
    );
  }

  inferIndexSet(node: ast.IndexSet): TypeDescription {
    return this.inferExpression(node.value);
  }

  inferIndexAccess(node: ast.IndexAccess): TypeDescription {
    const baseExprType = this.inferExpression(node.expr);
    if (isDescArrayType(baseExprType)) {
      return baseExprType.elementType;
    }

    return createErrorType(
      `Expected an array type, got \`${baseExprType.$type}\``,
      node
    );
  }

  inferPostfixOp(node: ast.PostfixOp): TypeDescription {
    return this.inferExpression(node.expr);
  }

  inferDenullExpression(node: ast.DenullExpression): TypeDescription {
    const baseExprType = this.inferExpression(node.expr);
    if (isDescNullableType(baseExprType)) {
      return baseExprType.type;
    }

    return createErrorType(
      `Expected a nullable type, got \`${baseExprType.$type}\``,
      node
    );
  }

  inferLiteralExpression(node: ast.LiteralExpression): TypeDescription {
    // integer literal could end with u/i(8|16|32|64)
    const hasType =
      "value" in node && (node.value.includes("u") || node.value.includes("i"));
    const extractType = (value: string) => {
      const type = value.match(/[ui](8|16|32|64)/)?.[0];
      if (type) {
        return type as
          | "u8"
          | "u16"
          | "u32"
          | "u64"
          | "i8"
          | "i16"
          | "i32"
          | "i64";
      }
      return undefined;
    };
    if (ast.isHexadecimalIntegerLiteral(node)) {
      if (hasType) {
        const type = extractType(node.value);
        if (type) {
          return createIntegerType(type);
        }
      }
      return createIntegerType(getMinStorageForInt(node.value, 16));
    } else if (ast.isDecimalIntegerLiteral(node)) {
      if (hasType) {
        const type = extractType(node.value);
        if (type) {
          return createIntegerType(type);
        }
      }
      return createIntegerType(getMinStorageForInt(node.value, 10));
    } else if (ast.isOctalIntegerLiteral(node)) {
      if (hasType) {
        const type = extractType(node.value);
        if (type) {
          return createIntegerType(type);
        }
      }
      return createIntegerType(getMinStorageForInt(node.value, 8));
    } else if (ast.isBinaryIntegerLiteral(node)) {
      if (hasType) {
        const type = extractType(node.value);
        if (type) {
          return createIntegerType(type);
        }
      }
      return createIntegerType(getMinStorageForInt(node.value, 2));
    } else if (ast.isFloatLiteral(node)) {
      return createFloatType("f32");
    } else if (ast.isDoubleLiteral(node)) {
      return createFloatType("f64");
    } else if (
      ast.isTrueBooleanLiteral(node) ||
      ast.isFalseBooleanLiteral(node)
    ) {
      return createBoolType();
    } else if (ast.isStringLiteral(node)) {
      return createErrorType(`Not implemented: \`${node.value}\``, node);
    } else if (ast.isBinaryStringLiteral(node)) {
      return createArrayType(createIntegerType("u8"));
    } else if (ast.isNullLiteral(node)) {
      return createNullType();
    }

    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferLambdaExpression(node: ast.LambdaExpression): TypeDescription {
    return this.createTypeFromNode(node.header);
  }

  inferDoExpression(node: ast.DoExpression): TypeDescription {
    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferGenericReferenceExpr(node: ast.GenericReferenceExpr): TypeDescription {
    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferArrayConstructionExpression(
    node: ast.ArrayExpressionList
  ): TypeDescription {
    const elementsTypes = node.values.map((v) => this.inferExpression(v.expr));
    return createArrayType(TypeCTypeProvider.findCommonType(elementsTypes));
  }

  inferNamedStructConstructionExpression(
    node: ast.StructFieldExprList
  ): TypeDescription {
    // TODO: handle spread expressions
    return createStructType(
      node.fields
        .filter((e) => ast.isStructFieldKeyValuePair(e))
        .map((f: ast.StructFieldExpr) =>
          createStructFieldDescription(
            (f as ast.StructFieldKeyValuePair).name,
            this.inferExpression((f as ast.StructFieldKeyValuePair).expr),
            f
          )
        )
    );
  }

  inferAnonymousStructConstructionExpression(
    node: ast.AnonymousStructConstructionExpression
  ): TypeDescription {
    // TODO: implement
    return createErrorType(`Not implemented: \`${node.$type}\``, node);
  }

  inferThisExpression(node: ast.ThisExpression): TypeDescription {
    // get the base class
    const baseClass = AstUtils.getContainerOfType(node, ast.isClassType);
    if (!baseClass) {
      return createErrorType(`\`this\` used outside of a class`, node);
    }

    return this.createTypeFromNode(baseClass);
  }

  inferQualifiedReference(node: ast.QualifiedReference): TypeDescription {
    // check if we have a variable declaration:
    /**
     * @access: public
     * @param x: Cool
     * @return: Cool
     */
    if (!node.reference.ref) {
      return createErrorType(
        `Unresolved reference \`${node.reference.$refText}\``,
        node
      );
    }

    // check if we have a class type:
    if (ast.isFunctionParameter(node.reference.ref)) {
      return this.createTypeFromNode(node.reference.ref.type);
    } else if (ast.isVariableDeclaration(node.reference.ref)) {
      if (!node.reference.ref.annotation) {
        return this.inferType(node.reference.ref.initializer);
      }
      return this.createTypeFromNode(node.reference.ref.annotation);
    } else if (ast.isNamespaceDecl(node.reference.ref)) {
      return createNamespaceDefinitionType(
        node.reference.ref.name,
        node.reference.ref
      );
    } else if (ast.isTypeDeclaration(node.reference.ref)) {
      return this.inferType(node.reference.ref);
    } else if (ast.isExternFFIDecl(node.reference.ref)) {
      return createFFIDefinitionType(
        node.reference.ref.name,
        node.reference.ref
      );
    }

    return createErrorType(`Cannot infer type of node \`${node.$type}\``, node);
  }

  inferMemberAccess(node: ast.MemberAccess): TypeDescription {
    if (!node || !node.element) {
      return createErrorType(`Incomplete expression`, node);
    }
    // make sure we don't infer the type of a non-inferrable node
    const baseExprType = this.inferExpression(node.expr);
    const identifiableFields = this.getIdentifiableFields(baseExprType);
    const field = identifiableFields
      .filter((e) => e != undefined)
      .find((f) => f.name === node.element.$refText);
    if (!field) {
      return createErrorType(
        `No field \`${node.element.$refText}\` found in type \`${baseExprType.$type}\``,
        node
      );
    }

    return this.inferType(field);
  }

  /**
   * Expression inference
   */
  inferTupleExpression(node: ast.TupleExpression): TypeDescription {
    return createTupleType([
      ...node.expressions.map((e) => this.inferExpression(e)),
    ]);
  }

  inferConditionalExpression(node: ast.ConditionalExpression): TypeDescription {
    // infer the condition
    const allTypes = [
      ...node.thens.map((t: ast.Expression) => this.inferExpression(t)),
      ...(node.elseExpr ? [this.inferExpression(node.elseExpr)] : []),
    ];

    return TypeCTypeProvider.findCommonType(allTypes);
  }

  inferMatchExpression(node: ast.MatchExpression): TypeDescription {
    // infer the target
    const allTypes = [
      ...node.cases.map((c: ast.MatchCaseExpression) =>
        this.inferExpression(c.body)
      ),
      ...(node.defaultExpr ? [this.inferExpression(node.defaultExpr)] : []),
    ];

    return TypeCTypeProvider.findCommonType(allTypes);
  }

  public static findCommonType(types: TypeDescription[]): TypeDescription {
    // TODO: implement
    //return createErrorType(`Cannot find common type of ${types.map(t => t.$type).join(", ")}`);
    return types[0];
  }

  /**
   * Returns the expected type of a node
   */
  inferExpectedType(node: AstNode): TypeDescription {
    // check if the cache
    const uri = this.getNodeUri(node);
    let cachedType = this.expectedTypeCache.get(uri, node);
    if (cachedType) {
      return cachedType;
    }

    if (ast.isVariableDeclSingle(node)) {
      if (node.annotation) {
        return this.createTypeFromNode(node.annotation);
      } else {
        return createAnyType();
      }
    } else if (ast.isFunctionParameter(node)) {
      return this.createTypeFromNode(node.type);
    }

    const expectedType = createAnyType();
    this.expectedTypeCache.set(uri, node, expectedType);
    return expectedType;
  }

  findTypeRoot(node: ast.TypeDeclaration): ast.DataType | undefined {
    let nodeDef: ast.DataType = node.definition;
    while (ast.isReferenceType(nodeDef)) {
      nodeDef = nodeDef.qname.ref?.definition!;
    }
    return nodeDef;
  }

  /**
   * Create a type from a node.
   * The node has to be a type node: Type Definition or type reference.
   * @param node - The node to create a type from.
   * @param genericsMap - A map of generic types to their arguments.
   * @returns The created type.
   */
  createTypeFromNode(
    node: AstNode,
    genericsMap: Map<ast.GenericType, ast.DataType | undefined> = new Map()
  ): TypeDescription {
    const uri = this.getNodeUri(node);
    const cachedType = this.typeCreationCache.get(uri, node);
    if (cachedType) {
      return cachedType;
    }

    let type: TypeDescription | undefined = createErrorType(
      `Loop??? \`${node.$type}\``,
      node
    );
    // set in the cache
    this.typeCreationCache.set(uri, node, type);

    function initGenericMap(
      typeArgs: ast.DataType[],
      genericsArg: ast.GenericType[]
    ) {
      for (let i = 0; i < genericsArg.length; i++) {
        genericsMap.set(genericsArg[i], typeArgs[i]);
      }
    }

    if (ast.isReferenceType(node)) {
      if (!node.qname.ref) {
        type = createErrorType(
          `Unresolved type name \`${node.qname.$refText}\``,
          node
        );
      } else {
        // build the generic map
        if (node.genericArgs && node.qname.ref.genericParameters) {
          initGenericMap(node.genericArgs, node.qname.ref.genericParameters);
        }

        type = this.createTypeFromNode(node.qname.ref, genericsMap);
      }
    } else if (ast.isTypeDeclaration(node)) {
      type = this.createTypeFromNode(node.definition, genericsMap);
    } else if (ast.isClassType(node)) {
      // 1. super types
      const superTypes = node.superTypes.map((s) =>
        this.createTypeFromNode(s, genericsMap)
      );
      // 2. attributes
      const attributes = node.attributes.map((a) =>
        createClassAttributeDescription(
          a.name,
          this.createTypeFromNode(a.type, genericsMap),
          a.isStatic,
          a.isLocal,
          a.isConst,
          a
        )
      );
      // 3. methods
      const methods = node.methods.map((m) =>
        createClassMethodDescription(
          m.method.names,
          this.createTypeFromNode(
            m.method.header,
            genericsMap
          ) as FunctionTypeDescription,
          m.isStatic,
          m.isLocal,
          m.isOverride,
          m.expr,
          m.body,
          m
        )
      );
      // 4. implementations
      //const implementations = node.implementations.map(i => this.createTypeFromNode(i, genericsMap));
      // 5. static block
      const staticBlock = node.staticBlock;
      type = createClassType(
        superTypes,
        attributes,
        methods,
        /*implementations,*/ [],
        staticBlock
      );
    } else if (ast.isInterfaceType(node)) {
      const superTypes = node.superTypes.map((s) =>
        this.createTypeFromNode(s, genericsMap)
      );
      const methods = node.methods.map((m) =>
        createInterfaceMethodDescription(
          m.names,
          this.createTypeFromNode(
            m.header,
            genericsMap
          ) as FunctionTypeDescription,
          m
        )
      );
      type = createInterfaceType(superTypes, methods);
    } else if (ast.isImplementationType(node)) {
      // TODO:
      type = createErrorType(
        "Cannot create type from implementation type",
        node
      );
    } else if (ast.isEnumType(node)) {
      type = createEnumType(
        node.cases.map((c) =>
          createEnumCaseDescription(c.name, c.init?.value, c)
        )
      );
    } else if (ast.isStructType(node)) {
      type = createStructType(
        node.fields.map((f) =>
          createStructFieldDescription(
            f.name,
            this.createTypeFromNode(f.type, genericsMap),
            f
          )
        )
      );
    } else if (ast.isVariantType(node)) {
      const constructors = node.constructors.map((v) =>
        createVariantConstructorType(
          v.name,
          v.params.map((p) => ({
            name: p.name,
            type: this.createTypeFromNode(p.type, genericsMap),
            node: p,
          })),
          undefined,
          v
        )
      );
      const variant = createVariantType(constructors, node);
      constructors.forEach((c) => (c.baseVariant = variant));
      type = variant;
    } else if (ast.isVariantConstructor(node)) {
      type = createVariantConstructorType(
        node.name,
        node.params.map((p) => ({
          name: p.name,
          type: this.createTypeFromNode(p.type, genericsMap),
          node: p,
        })),
        undefined,
        node
      );
    } else if (ast.isFunctionType(node)) {
      type = createFunctionType(
        node.header!.args.map((p) =>
          createFunctionParameterDescription(
            p.name,
            this.createTypeFromNode(p.type, genericsMap),
            p.isMut,
            p
          )
        ),
        node.header!.returnType
          ? this.createTypeFromNode(node.header!.returnType, genericsMap)
          : undefined,
        node.fnType === "cfn",
        node
      );
    }
    // We reach this by coming from classes/interface/implementation methods
    else if (ast.isFunctionHeader(node) || ast.isBuiltinSymbolFn(node)) {
      type = createFunctionType(
        node.args.map((p) =>
          createFunctionParameterDescription(
            p.name,
            this.createTypeFromNode(p.type, genericsMap),
            p.isMut,
            p
          )
        ),
        node.returnType
          ? this.createTypeFromNode(node.returnType, genericsMap)
          : undefined,
        false,
        node
      );
    } else if (ast.isBuiltinSymbolID(node)) {
      type = this.createTypeFromNode(node.type, genericsMap);
    } else if (ast.isArrayType(node)) {
      type = createArrayType(
        this.createTypeFromNode(node.arrayOf, genericsMap),
        node
      );
    } else if (ast.isPrimitiveType(node)) {
      if (node.stringType) {
        type = createStringType(node);
      } else if (node.boolType) {
        type = createBoolType(node);
      } else if (node.integerType) {
        type = createIntegerType(node.integerType, node);
      } else if (node.floatType) {
        type = createFloatType(node.floatType, node);
      } else if (node.nullType) {
        type = createNullType(node);
      } else if (node.voidType) {
        type = createVoidType(node);
      }
    } else if (ast.isGenericType(node)) {
      // see if we can find the type in the generics map
      const genericType = genericsMap.get(node);
      if (genericType) {
        type = this.createTypeFromNode(genericType, genericsMap);
      } else {
        type = createGenericType(node.name, node);
      }
    } else if (ast.isFunctionDeclaration(node)) {
      type = createFunctionType(
        node.header.args.map((p) =>
          createFunctionParameterDescription(
            p.name,
            this.createTypeFromNode(p.type, genericsMap),
            p.isMut,
            p
          )
        ),
        this.createTypeFromNode(node.header.returnType, genericsMap),
        node.fnType === "cfn",
        node
      );
    }

    if (!type) {
      type = createErrorType(
        `Cannot create type from node \`${node.$type}\``,
        node
      );
    }

    this.typeCreationCache.set(uri, node, type);
    return type;
  }

  getIdentifiableFields(type: TypeDescription): NamedAstNode[] {
    if (isDescClassType(type)) {
      return this.getClassIdentifiableFields(type);
    } else if (isDescClassDefinitionType(type)) {
      return this.getClassStaticIdentifiableFields(type.classReference);
    } else if (isDescInterfaceType(type)) {
      return this.getInterfaceIdentifiableFields(type);
    } else if (isDescEnumType(type)) {
    /*
    else if(isDescImplementationType(type)) {
        return type.attributes;
    }
    */
      return type.cases
        .filter((node) => node.$node !== undefined)
        .map((c) => ({
          ...c.$node!,
          name: c.name,
        }));
    } else if (isDescStructType(type)) {
      return type.fields
        .filter((node) => node.$node !== undefined)
        .map((f) => ({
          ...f.$node!,
          name: f.name,
        }));
    }
    // A variant type has no .. well nothing!
    //else if(isDescVariantType(type))
    else if (isDescVariantDefinitionType(type)) {
      return type.variant.constructors.map((c) => ({
        ...c.$node!,
        name: c.name,
      }));
    } else if (isDescNamespaceDefinitionType(type)) {
      return this.getNamespaceIdentifiableFields(type.$node);
    } else if (isDescFFIDefinitionType(type)) {
      return this.getFFIIdentifiableFields(type.$node);
    } else if (isDescArrayType(type)) {
      return this.getArrayIdentifiableFields(type);
    }
    return [];
  }

  getClassIdentifiableFields(type: ClassTypeDescription): NamedAstNode[] {
    console.log(type);
    // TODO: merge class with its supertypes & implementation methods
    const res = [
      ...type.attributes
        .filter((e) => e.$node !== undefined && !e.isStatic)
        .map((e) => ({
          ...e.$node!,
          name: e.name,
        })),
      ...type.methods
        .filter(
          // filter out init methods
          (e: ClassMethodDescription) => !e.names.includes("init")
        )
        .filter((e) => e.$node !== undefined && !e.isStatic)
        .map((e: ClassMethodDescription) =>
          [...e.names].map((name) => ({
            ...e.$node!,
            name,
          }))
        )
        .flat(),
    ];
    return res;
  }

  getClassStaticIdentifiableFields(type: ClassTypeDescription): NamedAstNode[] {
    // TODO: merge class with its supertypes & implementation methods
    const res = [
      ...type.attributes
        .filter((e) => e.$node !== undefined && e.isStatic && !e.isLocal)
        .map((e) => ({
          ...e.$node!,
          name: e.name,
        })),
      ...type.methods
        .filter(
          // filter out init methods
          (e: ClassMethodDescription) => !e.names.includes("init")
        )
        .filter((e) => e.$node !== undefined && e.isStatic && !e.isLocal)
        .map((e: ClassMethodDescription) =>
          [...e.names].map((name) => ({
            ...e.$node!,
            name,
          }))
        )
        .flat(),
    ];
    return res;
  }

  getInterfaceIdentifiableFields(
    type: InterfaceTypeDescription
  ): NamedAstNode[] {
    return type.methods
      .map((e: InterfaceMethodDescription) =>
        [...e.names].map((name) => ({
          ...e.$node!,
          name,
        }))
      )
      .flat();
  }

  getNamespaceIdentifiableFields(namespace: ast.NamespaceDecl): NamedAstNode[] {
    const exportedNodes: NamedAstNode[] = [];

    for (const node of namespace.definitions) {
      if (ast.isTypeDeclaration(node) && !node.isLocal) {
        exportedNodes.push(node);
      } else if (ast.isFunctionDeclaration(node) && !node.isLocal) {
        exportedNodes.push(node);
      } else if (
        ast.isVariableDeclarationStatement(node) &&
        !node.declarations.isLocal
      ) {
        for (const decl of node.declarations.variables) {
          if (decl.isConst) {
            exportedNodes.push(decl);
          }
        }
      } else if (ast.isExternFFIDecl(node) && !node.isLocal) {
        exportedNodes.push(node);
      } else if (ast.isNamespaceDecl(node) && !node.isLocal) {
        exportedNodes.push(node);
      }
    }

    return exportedNodes;
  }

  getFFIIdentifiableFields(ffi: ast.ExternFFIDecl): NamedAstNode[] {
    return ffi.methods;
  }

  getArrayIdentifiableFields(type: ArrayTypeDescription): NamedAstNode[] {
    /**
     * For array, we need to find the built-in prototype file, and filter for builtin symbols for array.
     * TODO: we need to clone the builtin based on the type of array.
     */

    const uris = new Set<string>([prototypeURI]);
    const allElements = this.indexManager
      .allElements(undefined, uris)
      .filter((e) => ast.isBuiltinDefinition(e.node))
      .toArray()
      .filter((e) => (e.node as ast.BuiltinDefinition).name == "array")
      .map((e) => (e.node as ast.BuiltinDefinition).symbols)
      .flat();
    return allElements;
  }
}
