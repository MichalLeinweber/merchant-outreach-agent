"""Shared machinery for the eval suite.

Nothing in here asserts anything. The tests do the asserting; this package
loads the datasets, talks to the TypeScript pipeline and computes the numbers,
so that a metric is defined in exactly one place and every test that reports it
reports the same thing.
"""
