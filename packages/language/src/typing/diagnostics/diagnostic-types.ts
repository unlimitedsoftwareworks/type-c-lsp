import { AstNode } from 'langium';

/**
 * A stored diagnostic produced during type inference.
 * Replayed through Langium's ValidationAcceptor by the thin TypeDiagnosticsValidator.
 */
export interface StoredDiagnostic {
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    node: AstNode;
    code?: string | number;
    property?: string;
}
