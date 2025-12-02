/**
 * (c) Copyright 2025 Soulaymen Chouri.
 * This software is licensed under the Apache License 2.0.
 * See the LICENSE.md file in the project root for details.
 */

/**
 * This file defines enums for the warnings that can be emitted by the TypeC language.
 */
export enum WarningCode {
    TCW001 = 'CLASS_NAME_SHOULD_START_WITH_CAPITAL',
}

/**
 * Info codes for helpful notifications that don't indicate problems.
 */
export enum InfoCode {
    TYPE_SHADOWS_IMPORTED_MODULE = 'TCI001',
}