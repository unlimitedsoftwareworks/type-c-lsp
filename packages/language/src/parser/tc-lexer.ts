import { createTokenInstance, type IToken } from 'chevrotain';
import { DefaultLexer, type LexerResult, type LangiumCoreServices, type TokenizeOptions } from 'langium';
import type { TypeCTokenBuilder } from './tc-token-builder.js';

// Token images that can end an expression (and thus precede a statement boundary)
const EXPRESSION_ENDER_IMAGES = new Set([
    ')', ']', '}',          // closing brackets
    '++', '--',             // postfix ops
    '!',                    // denull
    'this', 'null',         // keywords
    'true', 'false',        // booleans
    'unreachable',          // keyword
]);

// Token type names that can end an expression
const EXPRESSION_ENDER_TYPES = new Set([
    'ID', 'DECIMAL_INT_LITERAL', 'HEXADECIMAL_INT_LITERAL',
    'BINARY_INT_LITERAL', 'OCTAL_INT_LITERAL',
    'FLOAT_LITERAL', 'DOUBLE_LITERAL', 'STRING', 'BINARY_STRING',
]);

export class TypeCLexer extends DefaultLexer {
    private readonly stmtEndTokenBuilder: TypeCTokenBuilder;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.stmtEndTokenBuilder = services.parser.TokenBuilder as TypeCTokenBuilder;
    }

    override tokenize(text: string, options?: TokenizeOptions): LexerResult {
        const result = super.tokenize(text, options);
        result.tokens = this.injectStmtEnd(result.tokens);
        return result;
    }

    private isExpressionEnder(token: IToken): boolean {
        return EXPRESSION_ENDER_IMAGES.has(token.image) ||
               EXPRESSION_ENDER_TYPES.has(token.tokenType.name);
    }

    private injectStmtEnd(tokens: IToken[]): IToken[] {
        if (tokens.length < 2) return tokens;

        const stmtEndType = this.stmtEndTokenBuilder.stmtEndTokenType;
        const result: IToken[] = [tokens[0]];

        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            const prevToken = tokens[i - 1];

            if ((token.image === '++' || token.image === '--' ||
                 token.image === '(' || token.image === '[') &&
                this.isExpressionEnder(prevToken) &&
                (prevToken.endLine ?? prevToken.startLine!) < token.startLine!) {
                // Inject zero-width STMT_END before this token
                result.push(createTokenInstance(
                    stmtEndType,
                    '',
                    token.startOffset, token.startOffset,
                    token.startLine!, token.startLine!,
                    token.startColumn!, token.startColumn!
                ));
            }
            result.push(token);
        }
        return result;
    }
}
