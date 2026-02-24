---
name: "Harvard Printing Reference"
description: "Full reference for printing via lp command: printers, options, duplex, page ranges, queue management."
---

# Printing

Use `lp` command. Default printer: `Harvard-Crimson-Print`. Also available: `SEAS-Crimson-Print`.

## Basic Usage

```bash
lp -d Harvard-Crimson-Print file.pdf
```

## Options

- `-n N` -- number of copies
- `-o sides=two-sided-long-edge` -- duplex printing
- `-o number-up=N` -- N pages per sheet
- `-P 1-5` -- page range

## Queue Management

```bash
lpstat -p        # Check printers
lpstat -W active # Check queue
```
