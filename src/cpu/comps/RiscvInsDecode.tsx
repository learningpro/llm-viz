import { Vec3 } from "@/src/utils/vector";
import { IExePort, IComp, IExeComp, PortDir, ICompRenderArgs, IExeRunArgs } from "../CpuModel";
import { OpCode, Funct3Op, Funct3OpImm, Funct3Branch } from "../RiscvIsa";
import { ExeCompBuilder, ICompBuilderArgs, ICompDef } from "./CompBuilder";
import * as d3Color from 'd3-color';

export function createRiscvInsDecodeComps(_args: ICompBuilderArgs): ICompDef<any>[] {

    let w = 40;
    let h = 20;
    let alu: ICompDef<ICompDataInsDecoder> = {
        defId: 'insDecodeRiscv32_0',
        name: "Instruction Decoder",
        size: new Vec3(w, h),
        ports: [
            { id: 'ins', name: 'Ins', pos: new Vec3(0, 1), type: PortDir.In | PortDir.Data, width: 32 },

            { id: 'loadStoreCtrl', name: 'LS', pos: new Vec3(w, 1), type: PortDir.Out | PortDir.Ctrl, width: 4 },
            { id: 'addrOffset', name: 'Addr Offset', pos: new Vec3(w, 2), type: PortDir.Out | PortDir.Addr, width: 32 },
            { id: 'rhsImm', name: 'RHS Imm', pos: new Vec3(w, 6), type: PortDir.OutTri | PortDir.Data, width: 32 },

            { id: 'pcRegMuxCtrl', name: 'Mux', pos: new Vec3(1, h), type: PortDir.Out | PortDir.Ctrl, width: 1 },
            { id: 'regCtrl', name: 'Reg', pos: new Vec3(4, h), type: PortDir.Out | PortDir.Ctrl, width: 3 * 6 },
            { id: 'pcAddImm', name: 'PC+Imm', pos: new Vec3(7, h), type: PortDir.Out | PortDir.Addr, width: 32 },
            // { id: 'pcOutTristateCtrl', name: 'PC LHS', pos: new Vec3(5, h), type: PortDir.Out | PortDir.Ctrl, width: 1 },
            { id: 'pcBranchCtrl', name: 'PC Branch', pos: new Vec3(11, h), type: PortDir.Out | PortDir.Ctrl, width: 1 },
            { id: 'lhsMuxCtrl', name: 'LHS Sel', pos: new Vec3(15, h), type: PortDir.Out | PortDir.Ctrl, width: 1 },
            { id: 'aluCtrl', name: 'ALU', pos: new Vec3(18, h), type: PortDir.Out | PortDir.Ctrl, width: 5 },
        ],
        build: buildInsDecoder,
        render: renderInsDecoder,
    };

    return [alu];
}

export interface ICompDataInsDecoder {
    ins: IExePort;

    addrOffset: IExePort; // will get added to load/store address
    rhsImm: IExePort; // set's the RHS with an immediate value
    regCtrl: IExePort; // 3x 6-bit values: [0: outA, 1: outB, 2: inA]
    loadStoreCtrl: IExePort; // controls load/store
    aluCtrl: IExePort; // controls ALU, 5-bit value: [0: enable, 1: isBranch, 2: funct3, 3: isSpecial]
    // pcOutTristateCtrl: IExePort; // 1-bit value, enables PC -> LHS
    pcRegMuxCtrl: IExePort; // 1-bit value, controls writes to (PC, REG), from (ALU out, PC + x), or swaps them

    pcAddImm: IExePort; // gets added to PC, overrides +4 for jumps
    lhsMuxCtrl: IExePort; // 1-bit value, selects between PC & Reg A for LHS
    pcBranchCtrl: IExePort; // 1-bit value, selects between PC + 4 and PC + imm
}

export function buildInsDecoder(comp: IComp) {
    let builder = new ExeCompBuilder<ICompDataInsDecoder>(comp);
    let data = builder.addData({
        ins: builder.getPort('ins'),

        addrOffset: builder.getPort('addrOffset'),
        rhsImm: builder.getPort('rhsImm'),
        regCtrl: builder.getPort('regCtrl'),
        loadStoreCtrl: builder.getPort('loadStoreCtrl'),
        aluCtrl: builder.getPort('aluCtrl'),
        // pcOutTristateCtrl: builder.getPort('pcOutTristateCtrl'),
        pcRegMuxCtrl: builder.getPort('pcRegMuxCtrl'),

        pcAddImm: builder.getPort('pcAddImm'),
        lhsMuxCtrl: builder.getPort('lhsMuxCtrl'),

        pcBranchCtrl: builder.getPort('pcBranchCtrl'),
    });
    builder.addPhase(insDecoderPhase0, [data.ins], [data.addrOffset, data.rhsImm, data.regCtrl, data.loadStoreCtrl, data.aluCtrl, data.pcRegMuxCtrl, data.lhsMuxCtrl, data.pcAddImm]);
    return builder.build(data);
}

function insDecoderPhase0({ data }: IExeComp<ICompDataInsDecoder>, runArgs: IExeRunArgs) {
    let ins = data.ins.value >>> 0;

    const opCode = ins & 0b1111111;
    const funct3 = (ins >>> 12) & 0b111;
    const rd = (ins >>> 7) & 0b11111;
    const rs1 = (ins >>> 15) & 0b11111;
    const rs2 = (ins >>> 20) & 0b11111;

    data.regCtrl.value = 0;
    data.rhsImm.ioEnabled = false;

    // 1: ALU out => REG, PC + x => PC
    // 0: ALU out => PC,  PC + x => REG
    data.pcRegMuxCtrl.value = 1;
    // data.pcOutTristateCtrl.value = 0;
    data.pcAddImm.value = 0;
    data.lhsMuxCtrl.value = 1; // inverted
    data.pcBranchCtrl.value = 0;

    if (ins === 0) {
        // console.log('ILLEGAL INSTRUCTION: 0x0');
        runArgs.halt = true;
        // data.willHalt = true;
        return;
    }

    function setRegCtrl(enable: boolean, addr: number, offset: number) {
        let a = (enable ? 1 : 0) | (addr & 0b11111) << 1;
        let val = data.regCtrl.value;
        val = (val & ~(0b111111 << (offset * 6))) | (a << (offset * 6));
        data.regCtrl.value = val;
    }

    function setAluCtrl(enable: boolean, isBranch: boolean, funct3: number, isSpecial: boolean) {
        let val = (enable ? 1 : 0) << 5 |
                  (isBranch ? 1 : 0) << 4 |
                  funct3 << 1 |
                  (isSpecial ? 1 : 0) << 0;
        data.aluCtrl.value = val;
    }

    // console.log('opcode: ' + opCode.toString(16), ins.toString(2).padStart(32, '0'), OpCode[opCode], Funct3Op[funct3]);

    if (opCode === OpCode.OPIMM || opCode === OpCode.OP) {
        // console.log('OPIMM/OP', ins.toString(2).padStart(32, '0'));
        let isArithShiftOrSub = false;

        if (opCode === OpCode.OP) {
            setRegCtrl(true, rs2, 1); // reg[rs2] => RHS
            isArithShiftOrSub = ((ins >>> 30) & 0b1) === 0b1;
        } else if (funct3 === Funct3Op.SLLI || funct3 === Funct3Op.SRLI || funct3 === Funct3Op.SRAI) {
            data.rhsImm.value = rs2;
            data.rhsImm.ioEnabled = true;
        } else {
            data.rhsImm.value = signExtend12Bit(ins >>> 20);
            data.rhsImm.ioEnabled = true;
        }

        setRegCtrl(true, rs1, 0); // reg[rs1] => LHS
        setAluCtrl(true, false, funct3, isArithShiftOrSub);
        setRegCtrl(true, rd, 2); // ALU out => reg[rd]

    } else if (opCode === OpCode.LUI) {
        data.rhsImm.value = signExtend20Bit(ins >>> 12) << 12;
        setRegCtrl(true, 0x0, 0); // 0 => LHS
        setAluCtrl(true, false, Funct3Op.ADD, false);
        setRegCtrl(true, rd, 2); // ALU out => reg[rd]

    } else if (opCode === OpCode.AUIPC) {
        data.rhsImm.value = signExtend20Bit(ins >>> 12) << 12;
        data.lhsMuxCtrl.value = 0; // PC -> LHS enabled
        setAluCtrl(true, false, Funct3Op.ADD, false);
        setRegCtrl(true, rd, 2); // ALU out => reg[rd]

    } else if (opCode === OpCode.JAL) {
        let offsetRaw = (((ins >>> 21) & 0x3FF) << 1) | // 10 bytes
                        (((ins >>> 20) & 0x01) << 11) | // 1 byte
                        (((ins >>> 12) & 0xFF) << 12) | // 8 bytes
                        (((ins >>> 31) & 0x01) << 20);  // 1 byte

        data.lhsMuxCtrl.value = 0; // PC -> LHS enabled
        data.rhsImm.value = signExtend20Bit(offsetRaw);
        data.pcRegMuxCtrl.value = 0; // ALU out => PC; PC + 4 => REG
        setRegCtrl(true, rd, 2); // PC + 4 => reg[rd]

    } else if (opCode === OpCode.JALR) {
        let offset = signExtend12Bit(ins >>> 20);
        setRegCtrl(true, rs1, 0); // reg[rs1] => LHS
        data.rhsImm.value = offset;
        data.pcRegMuxCtrl.value = 0; // ALU out => PC; PC + 4 => REG
        setRegCtrl(true, rd, 2); // PC + 4 => reg[rd]

    } else if (opCode === OpCode.BRANCH) {

        setRegCtrl(true, rs1, 0); // reg[rs1] => LHS
        setRegCtrl(true, rs2, 1); // reg[rs2] => RHS

        setAluCtrl(true, true, funct3, false);

        let offsetRaw = (((ins >>>  8) & 0x0F) << 0 ) | // 4 bits
                        (((ins >>> 25) & 0x3F) << 4 ) | // 6 bits
                        (((ins >>>  7) & 0x01) << 10) | // 1 bits
                        (((ins >>> 31) & 0x01) << 11);  // 1 bits

        data.pcAddImm.value = signExtend12Bit(offsetRaw) << 1;
        // console.log('branch offset: ' + data.pcAddImm.value.toString(16), data.pcAddImm.value);
        data.lhsMuxCtrl.value = 1; // PC + offset => PC @TODO: not sure about this one, als a function of branch output
        data.pcBranchCtrl.value = 0; // PC + offset => PC

    } else if (opCode === OpCode.LOAD) {
        // let offset = signExtend12Bit(ins >>> 20);
        // let base = cpu.x[rs1] >>> 0;
        // let addr = base + offset;
        // let value = 0;
        // switch (funct3) {
        //     case Funct3LoadStore.LB: value = signExtend8Bit(mem.readByte(addr)); break;
        //     case Funct3LoadStore.LH: value = signExtend16Bit(mem.readHalfWord(addr)); break;
        //     case Funct3LoadStore.LW: value = signExtend32Bit(mem.readWord(addr)); break;
        //     case Funct3LoadStore.LBU: value = mem.readByte(addr); break;
        //     case Funct3LoadStore.LHU: value = mem.readHalfWord(addr); break;
        //     default: break;
        // }

        // @TODO: implement LOAD signals
        setRegCtrl(true, 0, 0);
        setRegCtrl(true, 0, 1);
        setRegCtrl(true, 0, 2);
        setAluCtrl(true, false, Funct3Op.ADD, false);

    } else if (opCode === OpCode.STORE) {
        // let offsetRaw = (((ins >>>  7) & 0x1F)     ) | // 5 bytes
        //                 (((ins >>> 25) & 0x7F) << 5);  // 7 bytes

        // let offset = signExtend12Bit(offsetRaw);
        // let base = cpu.x[rs1] >>> 0;
        // let addr = base + offset;
        // let value = cpu.x[rs2];

        // switch (funct3) {
        //     case Funct3LoadStore.SB: mem.writeByte(addr, value); break;
        //     case Funct3LoadStore.SH: mem.writeHalfWord(addr, value); break;
        //     case Funct3LoadStore.SW: mem.writeWord(addr, value); break;
        //     default: break;
        // }

        // @TODO: implement STORE signals
        setRegCtrl(true, 0, 0);
        setRegCtrl(true, 0, 1);
        setRegCtrl(true, 0, 2);
        setAluCtrl(true, false, Funct3Op.ADD, false);

    } else if (opCode === OpCode.SYSTEM) {
        runArgs.halt = true;
        // data.willHalt = true;
        /*
        let csr = (ins >>> 20);
        if (funct3 !== 0x0) {
            let srcVal = (funct3 & 0b100 ? rs1 : cpu.x[rs1]) >>> 0;
            let funct3Local = funct3 | 0b100;
            cpu.x[rd] = cpu.csr[csr];
            switch (funct3Local) {
                case Funct3CSR.CSRRWI: cpu.csr[csr] = srcVal; break;
                case Funct3CSR.CSRRSI: cpu.csr[csr] |= srcVal; break;
                case Funct3CSR.CSRRCI: cpu.csr[csr] &= ~srcVal; break;
            }
            // console.log(`CSR op ${Funct3CSR[funct3]} @ 0x${csr.toString(16)} (${CSR_Reg[csr]}): ${cpu.x[rd]} -> ${srcVal}`);
            if (csr < 0 || csr > 0xFFF) {
                console.log('ins: ' + ins.toString(2).padStart(32, '0'));
                console.log('Unknown CSR op: ' + csr.toString(16));
                cpu.halt = true;
            }
            // console.log('Unknown SYSTEM op (probably a CSR one): ' + funct3);
        } else {
            if (csr === 0x000) { // ecall
                let isTestResult = cpu.x[17] === 93;
                if (isTestResult) {
                    let testNum = cpu.x[10];
                    if (testNum === 0) {
                        console.log('ECALL: All tests passed!');
                    } else {
                        console.log(`ECALL: Test failed on test ${testNum >> 1}`);
                    }
                    cpu.halt = true;
                } else {
                    console.log('ECALL (unknown)');
                }
            } else if (csr === 0x001) { // ebreak
                console.log('EBREAK');
            } else if (csr === 0x102) { // sret
                console.log('SRET');
            } else if (csr === 0x302) { // mret
                pcOffset = (cpu.csr[CSR_Reg.mepc] >>> 0) - cpu.pc;
            } else {
                console.log('Unknown SYSTEM op: ' + csr);
            }
        }
        */
    } else {
        runArgs.halt = true;
        /*
        console.log('Unknown op: ' + opCode, ins.toString(2).padStart(32, '0'), cpu.pc.toString(16));
        // dumpCpu(cpu);
        cpu.halt = true;
        cpu.haltReason = 'Unknown op: ' + opCode;
        */
    }

    if (data.lhsMuxCtrl.value) {
        data.regCtrl.value |= 0b1;
        // setRegCtrl(true, 0, 0); // 0 => LHS (to ensure we don't leave a floating value on the bus)
    }
    // cpu.pc += pcOffset; // jump to location, or just move on to next instruction
    // cpu.x[0] = 0; // ensure x0 is always 0
}



export function signExtend8Bit(x: number) {
    return ((x & 0x80) === 0x80) ? x - 0x100 : x;
}

export function signExtend12Bit(x: number) {
    return ((x & 0x800) === 0x800) ? x - 0x1000 : x;
}

export function signExtend16Bit(x: number) {
    return ((x & 0x8000) === 0x8000) ? x - 0x10000 : x;
}

export function signExtend20Bit(x: number) {
    return ((x & 0x80000) === 0x80000) ? x - 0x100000 : x;
}

export function signExtend32Bit(x: number) {
    return ((x & 0x80000000) !== 0) ? x - 0x100000000 : x;
}

let u32Arr = new Uint32Array(1);
let s32Arr = new Int32Array(1);

export function ensureSigned32Bit(x: number) {
    s32Arr[0] = x;
    return s32Arr[0];
}

export function ensureUnsigned32Bit(x: number) {
    u32Arr[0] = x;
    return u32Arr[0];
}

function renderInsDecoder({ ctx, comp, exeComp, cvs, styles }: ICompRenderArgs<ICompDataInsDecoder>) {


    if (!exeComp) {
        return;
    }

    let data = exeComp.data;
    let ins = data.ins.value;

    ctx.font = `${styles.fontSize}px monospace`;
    let originalBitStr = ins.toString(2).padStart(32, '0');
    let width = ctx.measureText(originalBitStr).width;

    let leftX = comp.pos.x + comp.size.x/2 - width/2;
    let lineY = (a: number) => comp.pos.y + 1.0 + styles.lineHeight * (a + 2.0);

    ctx.font = `italic ${styles.fontSize}px sans-serif`;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('RISCV 32-bit Instruction Decode', leftX + width/2, lineY(-1.5));

    ctx.font = `${styles.fontSize}px monospace`;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    let hexText = ins.toString(16).padStart(8, '0');

    let alignedHexText = '';
    for (let i = 0; i < 4; i++) {
        alignedHexText += '   ' + hexText.substring(i * 2, i * 2 + 2) + '   ';
    }


    ctx.fillText(alignedHexText, leftX, lineY(0));
    // ctx.fillText(ins.toString(2).padStart(32, '0'), leftX, comp.pos.y + 0.5 + styles.lineHeight);


    // vertical lines separating the hex digits
    for (let i = 0; i < 3; i++) {
        let x = leftX + width / 4 * (i + 1);
        ctx.beginPath();
        ctx.moveTo(x, lineY(0));
        ctx.lineTo(x, lineY(2) - 0.2 * styles.lineHeight);
        ctx.setLineDash([0.4, 0.3]);
        ctx.strokeStyle = '#0005';
        ctx.stroke();
        ctx.setLineDash([]);
    }

    let strRemain = originalBitStr;

    let drawBitRange = (rightBit: number, count: number, color: string) => {
        let totalBits = originalBitStr.length;
        let rightIdx = totalBits - rightBit - 1;
        let leftIdx = rightIdx - count + 1;
        let str = originalBitStr.substring(leftIdx, rightIdx + 1);
        let strWrapped = ' '.repeat(leftIdx) + str + ' '.repeat(totalBits - rightIdx - 1);
        ctx.textAlign = 'left';
        ctx.fillStyle = color;
        ctx.fillText(strWrapped, leftX, lineY(1));
        strRemain = strRemain.substring(0, leftIdx) + ' '.repeat(count) + strRemain.substring(rightIdx + 1);
    };
    let bitRangeCenter = (rightBit: number, count: number) => {
        let bitWidth = width / originalBitStr.length;
        let targetIdx = originalBitStr.length - rightBit - count / 2;
        return leftX + bitWidth * targetIdx;
    };

    let opColor = '#e33';

    let rs1Color = '#3e3';
    let rs2Color = '#33e';
    let rdColor = '#ee3';
    let immColor = '#a3a';
    let func3Color = '#333';

    drawBitRange(0, 7, opColor);

    let opCode = ins & 0b1111111;
    const rd = (ins >>> 7) & 0b11111;
    const rs1 = (ins >>> 15) & 0b11111;
    const rs2 = (ins >>> 20) & 0b11111;

    let funct3 = (ins >>> 12) & 0b111;

    let drawBitsAndText = (rightBit: number, count: number, color: string, text: string, label: string) => {
        drawBitRange(rightBit, count, color);
        let center = bitRangeCenter(rightBit, count);
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.fillText(text, center, lineY(2));
    }

    drawBitsAndText(0, 7, opColor, OpCode[opCode] || '<invalid>', 'op');

    if (opCode === OpCode.OP || opCode === OpCode.OPIMM) {
        drawBitsAndText(15, 5, rs1Color, rs1.toString(), 'rs1');

        let funct3Str: string = '';

        if (opCode === OpCode.OP) {
            drawBitsAndText(20, 5, rs2Color, rs2.toString(), 'rs2');
            funct3Str = Funct3Op[funct3];

        } else if (opCode === OpCode.OPIMM) {
            drawBitsAndText(20, 12, immColor, data.rhsImm.value.toString(), 'imm');
            funct3Str = Funct3OpImm[funct3];
        }

        drawBitsAndText(12, 3, func3Color, funct3Str, 'funct3');
        drawBitsAndText(7, 5, rdColor, rd.toString(), 'rd');
    } else if (opCode === OpCode.BRANCH) {
        drawBitsAndText(15, 5, rs1Color, rs1.toString(), 'rs1');
        drawBitsAndText(20, 5, rs2Color, rs2.toString(), 'rs2');
        drawBitsAndText(12, 3, func3Color, Funct3Branch[funct3], 'funct3');
        // 8 (nbits: 4)
        // 25 (nbits: 6)
        // 7 (nbits: 1)
        // 31 (nbits: 1)
        drawBitsAndText(8, 4, d3Color.rgb(immColor).darker(-2).toString(), '.', 'i0');
        drawBitsAndText(25, 6, d3Color.rgb(immColor).darker(-1).toString(), '.', 'i1');
        drawBitsAndText(7, 1, d3Color.rgb(immColor).darker(0).toString(), '.', 'i2');
        drawBitsAndText(31, 1, d3Color.rgb(immColor).darker(1).toString(), '.', 'i2');
    }

    ctx.fillStyle = '#777';
    ctx.textAlign = 'left';
    ctx.fillText(strRemain, leftX, lineY(1));
}