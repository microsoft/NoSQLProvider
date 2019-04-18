/**
* FullTextSearchHelpers.ts
* Author: David de Regt
* Copyright: Microsoft 2017
*
* Reusable helper classes and functions for supporting Full Text Search.
*/
import { DbIndex, IndexSchema, QuerySortOrder, FullTextTermResolution, ItemType, KeyType } from './NoSqlProvider';
export declare function breakAndNormalizeSearchPhrase(phrase: string): string[];
export declare function getFullTextIndexWordsForItem(keyPath: string, item: any): string[];
export declare abstract class DbIndexFTSFromRangeQueries implements DbIndex {
    protected _indexSchema: IndexSchema | undefined;
    protected _primaryKeyPath: string | string[];
    protected _keyPath: string | string[];
    constructor(_indexSchema: IndexSchema | undefined, _primaryKeyPath: string | string[]);
    fullTextSearch(searchPhrase: string, resolution?: FullTextTermResolution, limit?: number): Promise<ItemType[]>;
    abstract getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    abstract getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    abstract getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    abstract countAll(): Promise<number>;
    abstract countOnly(key: KeyType): Promise<number>;
    abstract countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean): Promise<number>;
}
